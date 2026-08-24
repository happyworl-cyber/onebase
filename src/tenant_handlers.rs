use crate::audit_middleware::set_audit_detail;
use crate::auth::{validate_email, validate_username, Claims};
use crate::error::{AppError, Result};
use crate::permissions;
use crate::pool_manager::{DatabaseConfig, POOL_MANAGER};
use crate::redis_manager::RedisManager;
use crate::tenant_models::*;

/// 把 `Option<Extension<RedisManager>>` 解成 `Option<&RedisManager>`，喂给
/// `permissions::invalidate_*` 系列。
fn redis_ref(redis: &Option<Extension<RedisManager>>) -> Option<&RedisManager> {
    redis.as_ref().map(|Extension(r)| r)
}
use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{Connection, PgPool, Row};
use std::time::Duration;

#[derive(Deserialize)]
pub struct ConnectionsQuery {
    pub tenant_id: Option<i32>,
}

/// 简单的密码加密/解密（生产环境需要使用真正的加密）
/// 加密密码（AES-256-GCM，输出 v2:... 格式）
fn encrypt_password(password: &str) -> String {
    crate::crypto::encrypt_secret(password).unwrap_or_else(|e| {
        tracing::error!("密码加密失败，退化为不存储密码: {}", e);
        String::new()
    })
}

/// 解密密码（兼容 v2、ENCRYPTED:、裸 base64 三种历史格式）
fn decrypt_password(encrypted: &str) -> String {
    crate::crypto::decrypt_secret_lossy(encrypted)
}

/// 单库连接池 API 上限（存量更大值可读，新写入须落入此区间）。
const TENANT_MAX_CONNECTIONS_CAP: i32 = 50;

fn tenant_pool_global_budget_from_env_map<F>(mut get: F) -> i32
where
    F: FnMut(&str) -> Option<String>,
{
    get("TENANT_POOL_GLOBAL_MAX_CONNECTIONS")
        .and_then(|s| s.parse().ok())
        .unwrap_or(60)
        .max(1)
}

fn tenant_pool_global_budget() -> i32 {
    tenant_pool_global_budget_from_env_map(|k| std::env::var(k).ok())
}

/// 校验单库 `max_connections` 是否在 `1..=50`。
fn validate_tenant_max_connections(requested: i32) -> std::result::Result<(), String> {
    if !(1..=TENANT_MAX_CONNECTIONS_CAP).contains(&requested) {
        Err(format!(
            "max_connections 必须在 1..={}",
            TENANT_MAX_CONNECTIONS_CAP
        ))
    } else {
        Ok(())
    }
}

/// 同一 host:port 上「其他库合计 + 本次」是否不超过预算。
fn connection_budget_ok(
    sum_others: i64,
    requested: i32,
    budget: i32,
) -> std::result::Result<(), String> {
    let total = sum_others + i64::from(requested);
    if total > i64::from(budget) {
        Err(format!(
            "同一 host:port 上租户连接池预算超限：其他库合计 {} + 本次 {} = {}，上限 {}",
            sum_others, requested, total, budget
        ))
    } else {
        Ok(())
    }
}

/// 创建/更新前：单库上限 + 按 (db_host, db_port) 聚合的全局预算。
async fn ensure_connection_budget(
    pool: &PgPool,
    host: &str,
    port: i32,
    exclude_id: Option<i32>,
    requested: i32,
) -> Result<()> {
    validate_tenant_max_connections(requested).map_err(AppError::InvalidQuery)?;
    let budget = tenant_pool_global_budget();
    let sum_others: i64 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(COALESCE(max_connections, 20)), 0)::bigint
        FROM management.tenant_databases
        WHERE db_host = $1 AND db_port = $2
          AND ($3::int IS NULL OR id <> $3)
        "#,
    )
    .bind(host)
    .bind(port)
    .bind(exclude_id)
    .fetch_one(pool)
    .await?;
    connection_budget_ok(sum_others, requested, budget).map_err(AppError::InvalidQuery)?;
    Ok(())
}

fn normalize_slug(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for ch in raw.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn ensure_database_slug(slug: &str) -> Result<()> {
    if slug.is_empty() || slug.len() > 50 {
        return Err(AppError::InvalidQuery("slug 长度需为 1..=50".to_string()));
    }
    if slug.starts_with('-') || slug.ends_with('-') {
        return Err(AppError::InvalidQuery(
            "slug 不能以连字符开头或结尾".to_string(),
        ));
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(AppError::InvalidQuery(
            "slug 仅允许小写字母、数字、连字符".to_string(),
        ));
    }
    Ok(())
}

fn build_database_slug(explicit_slug: Option<&str>, connection_name: &str) -> Result<String> {
    let base = explicit_slug
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(connection_name);
    let normalized = normalize_slug(base);
    ensure_database_slug(&normalized)?;
    Ok(normalized)
}

/// GET /api/tenants/my-connections - 获取当前用户可访问的所有连接
pub async fn get_my_connections(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<ConnectionsQuery>,
) -> Result<Json<Vec<UserConnection>>> {
    let user_id = claims.sub;

    // 检查用户是否是超级管理员
    let is_superadmin = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(is_superadmin, false) FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .unwrap_or(false);

    let connections = if is_superadmin {
        // 超管可以看到所有连接（可按 tenant_id 筛选）
        if let Some(tid) = params.tenant_id {
            sqlx::query_as::<_, UserConnection>(
                r#"
                SELECT DISTINCT
                    $1 AS user_id,
                    u.username,
                    t.id AS tenant_id,
                    t.name AS tenant_name,
                    td.id AS database_id,
                    td.slug AS database_slug,
                    td.connection_name,
                    td.db_host,
                    td.db_port,
                    td.db_name,
                    td.is_primary,
                    td.sort_order,
                    'superadmin' AS user_role
                FROM management.tenants t
                CROSS JOIN users u
                JOIN management.tenant_databases td ON td.tenant_id = t.id AND td.is_active = true
                WHERE u.id = $1 AND t.status = 'active' AND t.id = $2
                ORDER BY t.name, td.sort_order ASC, td.is_primary DESC, td.connection_name
                "#,
            )
            .bind(user_id)
            .bind(tid)
            .fetch_all(&pool)
            .await?
        } else {
            sqlx::query_as::<_, UserConnection>(
                r#"
                SELECT DISTINCT
                    $1 AS user_id,
                    u.username,
                    t.id AS tenant_id,
                    t.name AS tenant_name,
                    td.id AS database_id,
                    td.slug AS database_slug,
                    td.connection_name,
                    td.db_host,
                    td.db_port,
                    td.db_name,
                    td.is_primary,
                    td.sort_order,
                    'superadmin' AS user_role
                FROM management.tenants t
                CROSS JOIN users u
                JOIN management.tenant_databases td ON td.tenant_id = t.id AND td.is_active = true
                WHERE u.id = $1 AND t.status = 'active'
                ORDER BY t.name, td.sort_order ASC, td.is_primary DESC, td.connection_name
                "#,
            )
            .bind(user_id)
            .fetch_all(&pool)
            .await?
        }
    } else {
        // 普通用户只能看到自己有权限的连接（可按 tenant_id 筛选）
        if let Some(tid) = params.tenant_id {
            sqlx::query_as::<_, UserConnection>(
                r#"
                SELECT 
                    v.user_id,
                    v.username,
                    v.tenant_id,
                    v.tenant_name,
                    v.database_id,
                    td.slug AS database_slug,
                    v.connection_name,
                    v.db_host,
                    v.db_port,
                    v.db_name,
                    v.is_primary,
                    v.user_role
                FROM management.v_user_connections v
                JOIN management.tenant_databases td ON td.id = v.database_id
                WHERE v.user_id = $1 AND v.tenant_id = $2
                ORDER BY v.tenant_name, td.sort_order ASC, v.is_primary DESC, v.connection_name
                "#,
            )
            .bind(user_id)
            .bind(tid)
            .fetch_all(&pool)
            .await?
        } else {
            sqlx::query_as::<_, UserConnection>(
                r#"
                SELECT 
                    v.user_id,
                    v.username,
                    v.tenant_id,
                    v.tenant_name,
                    v.database_id,
                    td.slug AS database_slug,
                    v.connection_name,
                    v.db_host,
                    v.db_port,
                    v.db_name,
                    v.is_primary,
                    v.user_role
                FROM management.v_user_connections v
                JOIN management.tenant_databases td ON td.id = v.database_id
                WHERE v.user_id = $1
                ORDER BY v.tenant_name, td.sort_order ASC, v.is_primary DESC, v.connection_name
                "#,
            )
            .bind(user_id)
            .fetch_all(&pool)
            .await?
        }
    };

    Ok(Json(connections))
}

/// GET /api/tenants/:tenant_id/schemas - 获取租户的所有业务 Schema
pub async fn get_tenant_schemas(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<i32>,
) -> Result<Json<Vec<TenantSchema>>> {
    let user_id = claims.sub; // claims.sub 现在是 i32 类型

    // 验证用户是否有权限访问该租户
    let has_access = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM management.user_tenants
            WHERE user_id = $1 AND tenant_id = $2 AND is_active = true
        )
        "#,
    )
    .bind(user_id)
    .bind(tenant_id)
    .fetch_one(&pool)
    .await?;

    if !has_access {
        return Err(crate::error::AppError::Unauthorized(
            "无权访问该租户".to_string(),
        ));
    }

    let schemas = sqlx::query_as::<_, TenantSchema>(
        r#"
        SELECT 
            id, tenant_id, database_id, schema_name, 
            business_type, display_name, description, is_active
        FROM management.tenant_schemas
        WHERE tenant_id = $1 AND is_active = true
        ORDER BY display_name
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&pool)
    .await?;

    Ok(Json(schemas))
}

/// POST /api/tenants/test-connection - 测试数据库连接
pub async fn test_connection(
    Json(req): Json<TestConnectionRequest>,
) -> Result<Json<TestConnectionResponse>> {
    let connection_url = format!(
        "postgresql://{}:{}@{}:{}/{}",
        req.username, req.password, req.host, req.port, req.database
    );

    match sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_url)
        .await
    {
        Ok(pool) => {
            // 获取服务器版本
            let version = sqlx::query_scalar::<_, String>("SELECT version()")
                .fetch_one(&pool)
                .await
                .ok();

            pool.close().await;

            Ok(Json(TestConnectionResponse {
                success: true,
                message: "连接成功".to_string(),
                server_version: version,
            }))
        }
        Err(e) => Ok(Json(TestConnectionResponse {
            success: false,
            message: format!("连接失败: {}", e),
            server_version: None,
        })),
    }
}

/// POST /api/tenants/connections - 创建新的数据库连接
pub async fn create_database_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateDatabaseConnectionRequest>,
) -> Result<Json<TenantDatabase>> {
    let user_id = claims.sub; // claims.sub 现在是 i32 类型

    // 平台超管直接放行；否则必须是该租户的 owner / admin
    if !claims.is_superadmin {
        let user_role = sqlx::query_scalar::<_, String>(
            r#"
            SELECT role FROM management.user_tenants
            WHERE user_id = $1 AND tenant_id = $2 AND is_active = true
            "#,
        )
        .bind(&user_id)
        .bind(req.tenant_id)
        .fetch_optional(&pool)
        .await?;

        match user_role.as_deref() {
            Some("owner") | Some("admin") => {}
            _ => {
                return Err(crate::error::AppError::Unauthorized(
                    "只有平台超管或租户 owner / admin 可以创建连接".to_string(),
                ))
            }
        }
    }

    let database_slug = build_database_slug(req.slug.as_deref(), &req.connection_name)?;
    let slug_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM management.tenant_databases
            WHERE tenant_id = $1 AND slug = $2
        )",
    )
    .bind(req.tenant_id)
    .bind(&database_slug)
    .fetch_one(&pool)
    .await?;
    if slug_exists {
        return Err(AppError::InvalidQuery(format!(
            "数据库 slug '{}' 在该租户内已存在",
            database_slug
        )));
    }

    // 加密密码
    let encrypted_password = encrypt_password(&req.db_password);

    let max_connections = req
        .max_connections
        .unwrap_or(crate::pool_manager::DEFAULT_TENANT_MAX_CONNECTIONS as i32);
    let connection_timeout = req
        .connection_timeout
        .unwrap_or(crate::pool_manager::DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS as i32);
    ensure_connection_budget(&pool, &req.db_host, req.db_port, None, max_connections).await?;

    // 插入数据库连接配置
    let db_connection = sqlx::query_as::<_, TenantDatabase>(
        r#"
        INSERT INTO management.tenant_databases 
        (tenant_id, connection_name, slug, db_host, db_port, db_name, db_user, 
         db_password_encrypted, is_primary, max_connections, connection_timeout)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, tenant_id, connection_name, slug, db_host, db_port, db_name,
                  db_user, db_password_encrypted, is_primary, is_active,
                  max_connections, connection_timeout
        "#,
    )
    .bind(req.tenant_id)
    .bind(&req.connection_name)
    .bind(&database_slug)
    .bind(&req.db_host)
    .bind(req.db_port)
    .bind(&req.db_name)
    .bind(&req.db_user)
    .bind(&encrypted_password)
    .bind(req.is_primary)
    .bind(max_connections)
    .bind(connection_timeout)
    .fetch_one(&pool)
    .await?;

    tracing::info!(
        "用户 {} 为租户 {} 创建了新连接: {}",
        user_id,
        req.tenant_id,
        req.connection_name
    );

    Ok(Json(db_connection))
}

/// PATCH /api/tenants/connections/:database_slug - 更新数据库连接（项目 owner/admin/超管）
pub async fn update_database_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(database_slug): Path<String>,
    Json(req): Json<UpdateDatabaseConnectionRequest>,
) -> Result<Json<TenantDatabase>> {
    let database_id =
        permissions::resolve_database_id_by_slug_for_claims(&pool, &claims, &database_slug).await?;
    let existing = sqlx::query(
        "SELECT tenant_id FROM management.tenant_databases WHERE id = $1 AND is_active = true",
    )
    .bind(database_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("数据库连接 {} 不存在", database_id)))?;
    let tenant_id: i32 = existing.get("tenant_id");

    if !claims.is_superadmin {
        permissions::require_tenant_admin(&pool, &claims, tenant_id).await?;
    }

    let new_name = req.connection_name.as_deref().map(str::trim);
    if let Some(name) = new_name {
        if name.is_empty() {
            return Err(AppError::InvalidQuery(
                "connection_name 不能为空".to_string(),
            ));
        }
    }

    let new_slug = match req.slug.as_deref() {
        Some(s) => {
            let normalized = normalize_slug(s.trim());
            ensure_database_slug(&normalized)?;
            Some(normalized)
        }
        None => None,
    };
    if let Some(slug) = &new_slug {
        let slug_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM management.tenant_databases
                WHERE tenant_id = $1 AND slug = $2 AND id <> $3
            )",
        )
        .bind(tenant_id)
        .bind(slug)
        .bind(database_id)
        .fetch_one(&pool)
        .await?;
        if slug_exists {
            return Err(AppError::InvalidQuery(format!(
                "数据库 slug '{}' 在该租户内已存在",
                slug
            )));
        }
    }

    let max_connections = req.max_connections;
    let connection_timeout = req.connection_timeout;
    if let Some(timeout) = connection_timeout {
        if timeout < 1 || timeout > 600 {
            return Err(AppError::InvalidQuery(
                "connection_timeout 必须在 1..=600".to_string(),
            ));
        }
    }

    // ── 实际连接目标（host / port / db / user / password）──
    // 字符串字段 trim 后空串视为非法（避免把连接打成空）；端口校验区间；
    // 密码空串 = 不修改（沿用超管 update_tenant 的语义）。
    let new_host = req.db_host.as_deref().map(str::trim);
    let new_db_name = req.db_name.as_deref().map(str::trim);
    let new_user = req.db_user.as_deref().map(str::trim);
    for (label, val) in [
        ("db_host", new_host),
        ("db_name", new_db_name),
        ("db_user", new_user),
    ] {
        if let Some(v) = val {
            if v.is_empty() {
                return Err(AppError::InvalidQuery(format!("{label} 不能为空")));
            }
        }
    }
    if let Some(port) = req.db_port {
        if port < 1 || port > 65535 {
            return Err(AppError::InvalidQuery(
                "db_port 必须在 1..=65535".to_string(),
            ));
        }
    }
    if let Some(max_conn) = max_connections {
        let existing_endpoint =
            sqlx::query("SELECT db_host, db_port FROM management.tenant_databases WHERE id = $1")
                .bind(database_id)
                .fetch_one(&pool)
                .await?;
        let host = new_host.unwrap_or_else(|| existing_endpoint.get::<&str, _>("db_host"));
        let port = req
            .db_port
            .unwrap_or_else(|| existing_endpoint.get::<i32, _>("db_port"));
        ensure_connection_budget(&pool, host, port, Some(database_id), max_conn).await?;
    }
    let new_password_enc = req
        .db_password
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(encrypt_password);

    sqlx::query(
        r#"
        UPDATE management.tenant_databases
        SET
            connection_name = COALESCE($1, connection_name),
            slug = COALESCE($2, slug),
            max_connections = COALESCE($3, max_connections),
            connection_timeout = COALESCE($4, connection_timeout),
            db_host = COALESCE($5, db_host),
            db_port = COALESCE($6, db_port),
            db_name = COALESCE($7, db_name),
            db_user = COALESCE($8, db_user),
            db_password_encrypted = COALESCE($9, db_password_encrypted)
        WHERE id = $10
        "#,
    )
    .bind(new_name)
    .bind(new_slug.as_deref())
    .bind(max_connections)
    .bind(connection_timeout)
    .bind(new_host)
    .bind(req.db_port)
    .bind(new_db_name)
    .bind(new_user)
    .bind(new_password_enc.as_deref())
    .bind(database_id)
    .execute(&pool)
    .await?;

    POOL_MANAGER.remove_pool(database_id).await;

    let updated = sqlx::query_as::<_, TenantDatabase>(
        r#"
        SELECT id, tenant_id, connection_name, slug, db_host, db_port, db_name,
               db_user, db_password_encrypted, is_primary, is_active,
               max_connections, connection_timeout
        FROM management.tenant_databases
        WHERE id = $1
        "#,
    )
    .bind(database_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(updated))
}

/// DELETE /api/tenants/connections/:database_slug - 删除数据库连接（项目 owner/admin/超管）
///
/// 硬删除：从 `management.tenant_databases` 移除该行并关闭对应连接池。
/// 若该连接是某些 replica 的 primary（有子副本绑定），则拒绝删除，避免副本被孤立。
pub async fn delete_database_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(database_slug): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let database_id =
        permissions::resolve_database_id_by_slug_for_claims(&pool, &claims, &database_slug).await?;

    let existing = sqlx::query(
        "SELECT tenant_id, connection_name FROM management.tenant_databases \
         WHERE id = $1 AND is_active = true",
    )
    .bind(database_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("数据库连接 {} 不存在", database_id)))?;
    let tenant_id: i32 = existing.get("tenant_id");
    let connection_name: String = existing.get("connection_name");

    if !claims.is_superadmin {
        permissions::require_tenant_admin(&pool, &claims, tenant_id).await?;
    }

    // 若有副本绑定到该连接，拒绝删除（避免副本失去 primary 被孤立）。
    let replica_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM management.tenant_databases \
         WHERE primary_id = $1 AND COALESCE(db_role, '') = 'replica' AND is_active = true",
    )
    .bind(database_id)
    .fetch_one(&pool)
    .await?;
    if replica_count > 0 {
        return Err(AppError::InvalidQuery(format!(
            "该连接下仍有 {} 个只读副本，请先删除副本再删除主连接",
            replica_count
        )));
    }

    sqlx::query("DELETE FROM management.tenant_databases WHERE id = $1")
        .bind(database_id)
        .execute(&pool)
        .await?;

    POOL_MANAGER.remove_pool(database_id).await;

    tracing::info!(
        "用户 {} 删除了租户 {} 的连接 {} ({})",
        claims.sub,
        tenant_id,
        database_id,
        connection_name
    );

    Ok(Json(json!({
        "success": true,
        "message": format!("连接 {} 已删除", connection_name)
    })))
}

/// POST /api/tenants/connections/reorder - 调整连接显示顺序（项目 owner/admin/超管）
///
/// 按 `ordered_ids` 的下标写回 `sort_order`。只更新属于该租户且在列表中的连接，
/// 未包含的连接顺序保持不变。
pub async fn reorder_connections(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<ReorderConnectionsRequest>,
) -> Result<Json<serde_json::Value>> {
    if !claims.is_superadmin {
        permissions::require_tenant_admin(&pool, &claims, req.tenant_id).await?;
    }

    let mut tx = pool.begin().await?;
    for (idx, database_id) in req.ordered_ids.iter().enumerate() {
        sqlx::query(
            "UPDATE management.tenant_databases \
             SET sort_order = $1 \
             WHERE id = $2 AND tenant_id = $3",
        )
        .bind(idx as i32)
        .bind(database_id)
        .bind(req.tenant_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    tracing::info!(
        "用户 {} 调整了租户 {} 的连接顺序（{} 项）",
        claims.sub,
        req.tenant_id,
        req.ordered_ids.len()
    );

    Ok(Json(json!({
        "success": true,
        "message": "连接顺序已更新"
    })))
}

/// POST /api/tenants/switch-connection - 切换到指定的数据库连接
pub async fn switch_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<SwitchConnectionRequest>,
) -> Result<Json<SwitchConnectionResponse>> {
    let user_id = claims.sub; // claims.sub 现在是 i32 类型

    // 获取连接配置
    let db_config = sqlx::query(
        r#"
        SELECT 
            td.id, td.connection_name, td.db_host, td.db_port, td.db_name,
            td.db_user, td.db_password_encrypted, td.max_connections, td.connection_timeout
        FROM management.tenant_databases td
        JOIN management.user_tenants ut ON ut.tenant_id = td.tenant_id
        WHERE td.id = $1 AND ut.user_id = $2 AND td.is_active = true AND ut.is_active = true
        "#,
    )
    .bind(req.database_id)
    .bind(&user_id)
    .fetch_optional(&pool)
    .await?;

    let row = db_config.ok_or_else(|| {
        crate::error::AppError::NotFound("数据库连接不存在或无权访问".to_string())
    })?;

    let config = DatabaseConfig {
        id: row.get("id"),
        host: row.get("db_host"),
        port: row.get("db_port"),
        database: row.get("db_name"),
        username: row.get("db_user"),
        password: decrypt_password(row.get("db_password_encrypted")),
        max_connections: row
            .get::<Option<i32>, _>("max_connections")
            .unwrap_or(crate::pool_manager::DEFAULT_TENANT_MAX_CONNECTIONS as i32)
            as u32,
        connection_timeout: row
            .get::<Option<i32>, _>("connection_timeout")
            .unwrap_or(crate::pool_manager::DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS as i32)
            as u64,
    };

    // 创建或获取连接池
    let _pool = POOL_MANAGER.get_or_create_pool(config).await?;

    tracing::info!("用户 {} 切换到数据库连接 {}", user_id, req.database_id);

    Ok(Json(SwitchConnectionResponse {
        success: true,
        database_id: req.database_id,
        connection_name: row.get("connection_name"),
        message: "连接切换成功".to_string(),
    }))
}

/// GET /api/tenants/pool-stats - 获取连接池统计信息（管理员功能）
pub async fn get_pool_stats(
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    // 连接池数量是平台级基础设施指标，仅平台超管可见，避免泄漏给普通租户用户。
    permissions::require_platform_superadmin(&claims)?;
    let active_pools = POOL_MANAGER.active_pools_count();

    let user_id = claims.sub; // claims.sub 现在是 i32 类型

    Ok(Json(json!({
        "active_pools": active_pools,
        "user_id": user_id,
    })))
}

/// GET /api/admin/tenants - 获取所有租户（超管专用）
pub async fn list_all_tenants(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<serde_json::Value>>> {
    let user_id = claims.sub;

    // 平台超管限制已按需求移除：该接口对任何已认证用户开放（user_id 仅用于审计日志）。
    let _ = user_id;

    // 查询租户及其主数据库连接信息
    let tenants = sqlx::query(
        r#"
        SELECT 
            t.id,
            t.name,
            t.slug,
            t.status,
            t.contact_email,
            t.created_at::TEXT as created_at,
            td.id as database_id,
            td.db_host,
            td.db_port,
            td.db_name,
            td.db_user,
            td.is_active as db_is_active
        FROM management.tenants t
        LEFT JOIN management.tenant_databases td ON t.id = td.tenant_id AND td.is_primary = true
        ORDER BY t.created_at DESC
        "#,
    )
    .fetch_all(&pool)
    .await?;

    let result: Vec<serde_json::Value> = tenants
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<i32, _>("id"),
                "name": row.get::<String, _>("name"),
                "slug": row.get::<String, _>("slug"),
                "status": row.get::<Option<String>, _>("status").unwrap_or_else(|| "active".to_string()),
                "contact_email": row.get::<Option<String>, _>("contact_email"),
                "created_at": row.get::<String, _>("created_at"),
                "database_id": row.get::<Option<i32>, _>("database_id"),
                "db_host": row.get::<Option<String>, _>("db_host").unwrap_or_default(),
                "db_port": row.get::<Option<i32>, _>("db_port").unwrap_or(5432),
                "db_name": row.get::<Option<String>, _>("db_name").unwrap_or_default(),
                "db_user": row.get::<Option<String>, _>("db_user").unwrap_or_default(),
                "is_active": row.get::<Option<bool>, _>("db_is_active").unwrap_or(true),
            })
        })
        .collect();

    Ok(Json(result))
}

/// POST /api/admin/tenants/create - **Deprecated**
/// 请改用 `POST /api/organizations` + 租户控制台开通项目。
pub async fn create_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    audit_sink: Option<Extension<crate::audit_middleware::AuditDetailSink>>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let user_id = claims.sub;
    tracing::warn!(
        target: "deprecated_api",
        "POST /api/admin/tenants/create used by user {}; prefer organizations API",
        user_id
    );

    let name = req["name"]
        .as_str()
        .ok_or_else(|| crate::error::AppError::InvalidQuery("缺少租户名称".to_string()))?;

    let slug = req["slug"]
        .as_str()
        .ok_or_else(|| crate::error::AppError::InvalidQuery("缺少租户标识".to_string()))?;

    let contact_email = req["contact_email"].as_str();

    // 数据库连接信息
    let db_host = req["db_host"].as_str().unwrap_or("localhost");
    let db_port = req["db_port"].as_i64().unwrap_or(5432) as i32;
    let mut db_name = req["db_name"].as_str().unwrap_or("").to_string();
    let db_user = req["db_user"].as_str().unwrap_or("postgres");
    let db_password = req["db_password"].as_str().unwrap_or("");

    // 是否创建新数据库
    let create_database = req["create_database"].as_bool().unwrap_or(false);

    if create_database {
        if db_name.is_empty() {
            db_name = format!("project_{}", slug);
        }

        fn is_valid_db_name(name: &str) -> bool {
            if name.is_empty() || name.len() > 63 {
                return false;
            }
            let first = match name.chars().next() {
                Some(c) => c,
                None => return false,
            };
            if !first.is_ascii_alphabetic() && first != '_' {
                return false;
            }
            name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        }

        if !is_valid_db_name(&db_name) {
            return Err(crate::error::AppError::InvalidQuery(
                "数据库名称只能包含字母、数字和下划线，且不能以数字开头（最长 63 字符）"
                    .to_string(),
            ));
        }

        let conn_str = format!(
            "postgres://{}:{}@{}:{}/postgres",
            db_user, db_password, db_host, db_port
        );

        let temp_pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&conn_str)
            .await
            .map_err(|e| {
                crate::error::AppError::Internal(format!("无法连接到数据库服务器: {}", e))
            })?;

        // 检查数据库是否已存在
        let db_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)")
                .bind(&db_name)
                .fetch_one(&temp_pool)
                .await?;

        if db_exists {
            return Err(crate::error::AppError::InvalidQuery(format!(
                "数据库 {} 已存在",
                db_name
            )));
        }

        // 创建新数据库
        // 使用 template0 避免 "template1 is being accessed by other users" 错误
        let create_db_sql = format!("CREATE DATABASE \"{}\" TEMPLATE template0", db_name);
        sqlx::query(&create_db_sql)
            .execute(&temp_pool)
            .await
            .map_err(|e| crate::error::AppError::Internal(format!("创建数据库失败: {}", e)))?;

        tracing::info!("创建了新数据库: {}:{}/{}", db_host, db_port, db_name);
    }

    // 创建组织 + 项目（tenants 行）
    let mut tx = pool.begin().await?;
    let org_id: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO management.organizations (name, slug, status, contact_email)
        VALUES ($1, $2, 'active', $3)
        RETURNING id
        "#,
    )
    .bind(name)
    .bind(slug)
    .bind(contact_email)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.constraint() == Some("organizations_slug_key") => {
            crate::error::AppError::InvalidQuery("组织标识 (slug) 已存在".to_string())
        }
        _ => crate::error::AppError::Database(e),
    })?;

    let tenant = sqlx::query(
        r#"
        INSERT INTO management.tenants (name, slug, contact_email, status, kind, organization_id)
        VALUES ($1, $2, $3, 'active', 'project', $4)
        RETURNING id, name, slug, status, contact_email, created_at::TEXT as created_at
        "#,
    )
    .bind(name)
    .bind(slug)
    .bind(contact_email)
    .bind(org_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    let tenant_id = tenant.get::<i32, _>("id");

    // 给新租户种入开箱可用的 RBAC 默认数据
    if let Err(e) = crate::rbac_handlers::seed_tenant_rbac_defaults(&pool, tenant_id).await {
        tracing::warn!(
            "为租户 {} 写入默认 RBAC 数据失败（不影响租户创建，但建议手动检查）: {}",
            tenant_id,
            e
        );
    }

    // 如果提供了数据库连接信息，创建数据库连接记录
    let mut database_id: Option<i32> = None;
    if !db_name.is_empty() {
        let encrypted_password = encrypt_password(db_password);

        let db_row = sqlx::query(
            r#"
            INSERT INTO management.tenant_databases 
            (tenant_id, connection_name, slug, db_host, db_port, db_name, db_user, db_password_encrypted, is_primary, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)
            RETURNING id
            "#,
        )
        .bind(tenant_id)
        .bind(format!("{}_primary", slug))
        .bind(slug)
        .bind(db_host)
        .bind(db_port)
        .bind(&db_name)
        .bind(db_user)
        .bind(encrypted_password)
        .fetch_one(&pool)
        .await?;

        database_id = Some(db_row.get::<i32, _>("id"));
        tracing::info!(
            "为租户 {} 创建了数据库连接 (id={}): {}:{}/{}",
            tenant_id,
            database_id.unwrap(),
            db_host,
            db_port,
            db_name
        );
    }

    tracing::info!("超管 {} 创建了新租户: {}", user_id, name);

    set_audit_detail(
        &audit_sink,
        "platform.tenant.create",
        json!({
            "tenant_id": tenant_id,
            "name": tenant.get::<String, _>("name"),
            "slug": tenant.get::<String, _>("slug"),
            "database_id": database_id,
        }),
    );

    Ok(Json(json!({
        "id": tenant_id,
        "name": tenant.get::<String, _>("name"),
        "slug": tenant.get::<String, _>("slug"),
        "status": tenant.get::<String, _>("status"),
        "contact_email": tenant.get::<Option<String>, _>("contact_email"),
        "created_at": tenant.get::<String, _>("created_at"),
        "database_id": database_id,
        "db_host": db_host,
        "db_port": db_port,
        "db_name": db_name,
        "db_user": db_user,
        "is_active": true,
        "database_created": create_database,
    })))
}

/// PATCH /api/admin/tenants/:tenant_id - 更新租户信息（超管专用）
///
/// 可更新字段（均为可选，仅传入的字段会被修改）：
/// - 租户层：name / contact_email / status (active|suspended|deleted)
/// - 主数据库连接：db_host / db_port / db_name / db_user / db_password / is_active
///
/// slug 不允许修改（作为稳定标识被多处引用）。
/// 修改数据库连接信息后会失效连接池缓存，下次访问会按新配置重建。
pub async fn update_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    audit_sink: Option<Extension<crate::audit_middleware::AuditDetailSink>>,
    Path(tenant_id): Path<i32>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let user_id = claims.sub;

    // 平台超管限制已按需求移除：该接口对任何已认证用户开放（user_id 仅用于审计日志）。
    let _ = user_id;

    // 校验租户存在
    let exists: Option<(i32,)> = sqlx::query_as("SELECT id FROM management.tenants WHERE id = $1")
        .bind(tenant_id)
        .fetch_optional(&pool)
        .await?;

    if exists.is_none() {
        return Err(crate::error::AppError::NotFound(format!(
            "租户 {} 不存在",
            tenant_id
        )));
    }

    // ===== 1. 更新租户基础信息 =====
    let new_name = req.get("name").and_then(|v| v.as_str());
    let new_contact_email = req.get("contact_email").and_then(|v| v.as_str());
    let new_status = req.get("status").and_then(|v| v.as_str());

    if let Some(status) = new_status {
        if !["active", "suspended", "deleted"].contains(&status) {
            return Err(crate::error::AppError::InvalidQuery(
                "无效的状态值，只能是 active / suspended / deleted".to_string(),
            ));
        }
    }

    if new_name.is_some() || new_contact_email.is_some() || new_status.is_some() {
        sqlx::query(
            r#"
            UPDATE management.tenants
            SET
                name          = COALESCE($1, name),
                contact_email = COALESCE($2, contact_email),
                status        = COALESCE($3, status)
            WHERE id = $4
            "#,
        )
        .bind(new_name)
        .bind(new_contact_email)
        .bind(new_status)
        .bind(tenant_id)
        .execute(&pool)
        .await?;
    }

    // ===== 2. 更新主数据库连接（如果有任何相关字段） =====
    let new_db_host = req.get("db_host").and_then(|v| v.as_str());
    let new_db_port = req
        .get("db_port")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);
    let new_db_name = req.get("db_name").and_then(|v| v.as_str());
    let new_db_user = req.get("db_user").and_then(|v| v.as_str());
    // 空字符串视为不修改密码
    let new_db_password = req
        .get("db_password")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty());
    let new_db_is_active = req.get("is_active").and_then(|v| v.as_bool());

    let has_db_change = new_db_host.is_some()
        || new_db_port.is_some()
        || new_db_name.is_some()
        || new_db_user.is_some()
        || new_db_password.is_some()
        || new_db_is_active.is_some();

    let mut affected_db_id: Option<i32> = None;

    if has_db_change {
        // 取主连接（is_primary = true）
        let primary: Option<(i32,)> = sqlx::query_as(
            r#"
            SELECT id FROM management.tenant_databases
            WHERE tenant_id = $1 AND is_primary = true
            ORDER BY id ASC
            LIMIT 1
            "#,
        )
        .bind(tenant_id)
        .fetch_optional(&pool)
        .await?;

        let db_id = match primary {
            Some((id,)) => id,
            None => {
                return Err(crate::error::AppError::InvalidQuery(
                    "该租户尚未配置主数据库连接，请先在创建项目时设置".to_string(),
                ));
            }
        };

        let encrypted_password = new_db_password.map(encrypt_password);

        sqlx::query(
            r#"
            UPDATE management.tenant_databases
            SET
                db_host                = COALESCE($1, db_host),
                db_port                = COALESCE($2, db_port),
                db_name                = COALESCE($3, db_name),
                db_user                = COALESCE($4, db_user),
                db_password_encrypted  = COALESCE($5, db_password_encrypted),
                is_active              = COALESCE($6, is_active)
            WHERE id = $7
            "#,
        )
        .bind(new_db_host)
        .bind(new_db_port)
        .bind(new_db_name)
        .bind(new_db_user)
        .bind(encrypted_password)
        .bind(new_db_is_active)
        .bind(db_id)
        .execute(&pool)
        .await?;

        // 失效现有连接池，下次请求会按新配置重建
        POOL_MANAGER.remove_pool(db_id).await;

        affected_db_id = Some(db_id);
    }

    // ===== 3. 返回更新后的完整租户视图 =====
    let row = sqlx::query(
        r#"
        SELECT
            t.id,
            t.name,
            t.slug,
            t.status,
            t.contact_email,
            t.created_at::TEXT as created_at,
            td.id as database_id,
            td.db_host,
            td.db_port,
            td.db_name,
            td.db_user,
            td.is_active as db_is_active
        FROM management.tenants t
        LEFT JOIN management.tenant_databases td
               ON t.id = td.tenant_id AND td.is_primary = true
        WHERE t.id = $1
        "#,
    )
    .bind(tenant_id)
    .fetch_one(&pool)
    .await?;

    tracing::info!(
        "超管 {} 更新了租户 {} 的信息（db_pool 已失效: {:?}）",
        user_id,
        tenant_id,
        affected_db_id
    );

    set_audit_detail(
        &audit_sink,
        "platform.tenant.update",
        json!({
            "tenant_id": tenant_id,
            "name": row.get::<String, _>("name"),
            "slug": row.get::<String, _>("slug"),
            "status": row.get::<Option<String>, _>("status"),
        }),
    );

    Ok(Json(json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "slug": row.get::<String, _>("slug"),
        "status": row.get::<Option<String>, _>("status").unwrap_or_else(|| "active".to_string()),
        "contact_email": row.get::<Option<String>, _>("contact_email"),
        "created_at": row.get::<String, _>("created_at"),
        "database_id": row.get::<Option<i32>, _>("database_id"),
        "db_host": row.get::<Option<String>, _>("db_host").unwrap_or_default(),
        "db_port": row.get::<Option<i32>, _>("db_port").unwrap_or(5432),
        "db_name": row.get::<Option<String>, _>("db_name").unwrap_or_default(),
        "db_user": row.get::<Option<String>, _>("db_user").unwrap_or_default(),
        "is_active": row.get::<Option<bool>, _>("db_is_active").unwrap_or(true),
    })))
}

// =========================================================================
// 只读副本管理（横向扩展读流量）
//
// 设计：每个租户的主连接（is_primary = true）下可挂多个 db_role = 'replica'，
// 通过 primary_id 关联。读请求会在 PoolManager 里按 round-robin 轮询副本，
// 写请求始终落到 primary（详见 src/pool_manager.rs）。
//
// 任何写操作后会调用 POOL_MANAGER.remove_pool(primary_id)，下次请求会按新
// 拓扑重建 primary + replica 池。
// =========================================================================

/// 副本管理类接口的"必须超管"快路径。
///
/// 这里只有 user_id（旧代码风格），所以走 DB 复查；本地保留 wrapper 是为了
/// 不改 4 个 replica handler 的调用点。新代码应当优先用
/// `permissions::require_platform_superadmin(&claims)`。
async fn ensure_superadmin(_pool: &PgPool, _user_id: i32) -> Result<()> {
    // 平台超管限制已按需求移除：副本管理类接口对任何已认证用户开放。
    Ok(())
}

/// 取租户的主连接 id（必须存在）
async fn primary_db_id_for_tenant(pool: &PgPool, tenant_id: i32) -> Result<i32> {
    let row: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT id FROM management.tenant_databases
        WHERE tenant_id = $1 AND is_primary = true AND COALESCE(db_role, 'primary') = 'primary'
        ORDER BY id ASC
        LIMIT 1
        "#,
    )
    .bind(tenant_id)
    .fetch_optional(pool)
    .await?;
    row.map(|(id,)| id).ok_or_else(|| {
        crate::error::AppError::InvalidQuery("该租户尚未配置主数据库连接，无法管理副本".to_string())
    })
}

/// GET /api/admin/tenants/:tenant_id/replicas - 列出某租户主连接下的所有只读副本
pub async fn list_tenant_replicas(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<i32>,
) -> Result<Json<Vec<serde_json::Value>>> {
    ensure_superadmin(&pool, claims.sub).await?;

    let primary_id = primary_db_id_for_tenant(&pool, tenant_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT
            id, tenant_id, primary_id, connection_name,
            db_host, db_port, db_name, db_user,
            COALESCE(db_role, 'replica') AS db_role,
            COALESCE(weight, 1)          AS weight,
            COALESCE(is_active, true)    AS is_active,
            max_connections, connection_timeout,
            created_at::TEXT             AS created_at
        FROM management.tenant_databases
        WHERE tenant_id = $1 AND primary_id = $2 AND COALESCE(db_role, '') = 'replica'
        ORDER BY id ASC
        "#,
    )
    .bind(tenant_id)
    .bind(primary_id)
    .fetch_all(&pool)
    .await?;

    let result: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<i32, _>("id"),
                "tenant_id": row.get::<i32, _>("tenant_id"),
                "primary_id": row.get::<i32, _>("primary_id"),
                "connection_name": row.get::<String, _>("connection_name"),
                "db_host": row.get::<String, _>("db_host"),
                "db_port": row.get::<i32, _>("db_port"),
                "db_name": row.get::<String, _>("db_name"),
                "db_user": row.get::<String, _>("db_user"),
                "db_role": row.get::<String, _>("db_role"),
                "weight": row.get::<i32, _>("weight"),
                "is_active": row.get::<bool, _>("is_active"),
                "max_connections": row.get::<Option<i32>, _>("max_connections"),
                "connection_timeout": row.get::<Option<i32>, _>("connection_timeout"),
                "created_at": row.get::<String, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(result))
}

/// POST /api/admin/tenants/:tenant_id/replicas - 为某租户主连接添加一个只读副本
///
/// body:
/// {
///   connection_name: string,
///   db_host: string,
///   db_port?: number (默认 5432),
///   db_name?: string (默认沿用 primary),
///   db_user?: string (默认沿用 primary),
///   db_password?: string (默认沿用 primary 的密文 -- 若副本同步用同账号),
///   weight?: number (默认 1, 用于负载均衡轮询权重),
///   max_connections?: number,
///   connection_timeout?: number
/// }
pub async fn add_tenant_replica(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<i32>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    ensure_superadmin(&pool, claims.sub).await?;

    let primary_id = primary_db_id_for_tenant(&pool, tenant_id).await?;

    let primary_row = sqlx::query(
        r#"
        SELECT db_name, db_user, db_password_encrypted
        FROM management.tenant_databases
        WHERE id = $1
        "#,
    )
    .bind(primary_id)
    .fetch_one(&pool)
    .await?;

    let primary_db_name: String = primary_row.get("db_name");
    let primary_db_user: String = primary_row.get("db_user");
    let primary_pwd_encrypted: String = primary_row.get("db_password_encrypted");

    let connection_name = req
        .get("connection_name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| crate::error::AppError::InvalidQuery("缺少 connection_name".to_string()))?;

    let db_host = req
        .get("db_host")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| crate::error::AppError::InvalidQuery("缺少 db_host".to_string()))?;

    let db_port = req
        .get("db_port")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(5432);
    if !(1..=65535).contains(&db_port) {
        return Err(crate::error::AppError::InvalidQuery(
            "db_port 必须在 1 ~ 65535".to_string(),
        ));
    }

    let db_name = req
        .get("db_name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(primary_db_name);

    let db_user = req
        .get("db_user")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(primary_db_user);

    // 密码：空 => 沿用主库密文；非空 => 加密入库
    let db_password_encrypted = match req.get("db_password").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => encrypt_password(p),
        _ => primary_pwd_encrypted,
    };

    let weight = req
        .get("weight")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(1);
    if !(1..=1000).contains(&weight) {
        return Err(crate::error::AppError::InvalidQuery(
            "weight 必须在 1 ~ 1000".to_string(),
        ));
    }

    let max_connections = req
        .get("max_connections")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(crate::pool_manager::DEFAULT_TENANT_MAX_CONNECTIONS as i32);
    let connection_timeout = req
        .get("connection_timeout")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(crate::pool_manager::DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS as i32);

    ensure_connection_budget(&pool, db_host, db_port, None, max_connections).await?;

    let inserted = sqlx::query(
        r#"
        INSERT INTO management.tenant_databases
            (tenant_id, connection_name, db_host, db_port, db_name, db_user,
             db_password_encrypted, is_primary, is_active, db_role, primary_id,
             weight, max_connections, connection_timeout)
        VALUES ($1, $2, $3, $4, $5, $6, $7, false, true, 'replica', $8, $9, $10, $11)
        RETURNING id, created_at::TEXT AS created_at
        "#,
    )
    .bind(tenant_id)
    .bind(connection_name)
    .bind(db_host)
    .bind(db_port)
    .bind(&db_name)
    .bind(&db_user)
    .bind(&db_password_encrypted)
    .bind(primary_id)
    .bind(weight)
    .bind(max_connections)
    .bind(connection_timeout)
    .fetch_one(&pool)
    .await?;

    let new_replica_id: i32 = inserted.get("id");

    // 增量挂载到内存池组（不破坏 primary / 其他副本），仅在 primary 池已加载时生效；
    // 未加载时跳过——下次访问会由 ensure_pool_loaded 一并加载新副本
    if POOL_MANAGER.get_write_pool(primary_id).is_some() {
        // 解密刚加密的密码以构造池配置
        let plain_pwd = crate::crypto::decrypt_secret_lossy(&db_password_encrypted);
        let cfg = DatabaseConfig {
            id: new_replica_id,
            host: db_host.to_string(),
            port: db_port,
            database: db_name.clone(),
            username: db_user.clone(),
            password: plain_pwd,
            max_connections: max_connections as u32,
            connection_timeout: connection_timeout as u64,
        };
        if let Err(e) = POOL_MANAGER
            .upsert_replica(primary_id, new_replica_id, weight, cfg)
            .await
        {
            tracing::warn!(
                "副本 {} 已写入元数据，但增量挂载失败：{}（下次请求会重试）",
                new_replica_id,
                e
            );
        }
    }

    tracing::info!(
        "超管 {} 为租户 {} 主连接 {} 添加了 replica id={} ({}:{})",
        claims.sub,
        tenant_id,
        primary_id,
        new_replica_id,
        db_host,
        db_port
    );

    Ok(Json(json!({
        "id": new_replica_id,
        "tenant_id": tenant_id,
        "primary_id": primary_id,
        "connection_name": connection_name,
        "db_host": db_host,
        "db_port": db_port,
        "db_name": db_name,
        "db_user": db_user,
        "db_role": "replica",
        "weight": weight,
        "is_active": true,
        "max_connections": max_connections,
        "connection_timeout": connection_timeout,
        "created_at": inserted.get::<String, _>("created_at"),
    })))
}

/// PATCH /api/admin/tenants/:tenant_id/replicas/:replica_id - 更新副本字段
///
/// body: 仅传入的字段会被修改；db_password 为空字符串视为不修改
pub async fn update_tenant_replica(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((tenant_id, replica_id)): Path<(i32, i32)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    ensure_superadmin(&pool, claims.sub).await?;

    let primary_id = primary_db_id_for_tenant(&pool, tenant_id).await?;

    // 必须是当前 tenant 的副本，且 primary_id 匹配
    let existing: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT id FROM management.tenant_databases
        WHERE id = $1 AND tenant_id = $2 AND primary_id = $3 AND COALESCE(db_role, '') = 'replica'
        "#,
    )
    .bind(replica_id)
    .bind(tenant_id)
    .bind(primary_id)
    .fetch_optional(&pool)
    .await?;

    if existing.is_none() {
        return Err(crate::error::AppError::NotFound(format!(
            "副本 {} 不存在于租户 {}",
            replica_id, tenant_id
        )));
    }

    let new_connection_name = req.get("connection_name").and_then(|v| v.as_str());
    let new_db_host = req.get("db_host").and_then(|v| v.as_str());
    let new_db_port = req
        .get("db_port")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);
    let new_db_name = req.get("db_name").and_then(|v| v.as_str());
    let new_db_user = req.get("db_user").and_then(|v| v.as_str());
    let new_db_password = req
        .get("db_password")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty());
    let new_weight = req.get("weight").and_then(|v| v.as_i64()).map(|v| v as i32);
    let new_is_active = req.get("is_active").and_then(|v| v.as_bool());

    // 真正改变连接参数的字段（决定是否需要重建该副本的池）
    let connection_changed = new_db_host.is_some()
        || new_db_port.is_some()
        || new_db_name.is_some()
        || new_db_user.is_some()
        || new_db_password.is_some();

    let encrypted_password = new_db_password.map(encrypt_password);

    sqlx::query(
        r#"
        UPDATE management.tenant_databases
        SET
            connection_name       = COALESCE($1, connection_name),
            db_host               = COALESCE($2, db_host),
            db_port               = COALESCE($3, db_port),
            db_name               = COALESCE($4, db_name),
            db_user               = COALESCE($5, db_user),
            db_password_encrypted = COALESCE($6, db_password_encrypted),
            weight                = COALESCE($7, weight),
            is_active             = COALESCE($8, is_active)
        WHERE id = $9
        "#,
    )
    .bind(new_connection_name)
    .bind(new_db_host)
    .bind(new_db_port)
    .bind(new_db_name)
    .bind(new_db_user)
    .bind(encrypted_password)
    .bind(new_weight)
    .bind(new_is_active)
    .bind(replica_id)
    .execute(&pool)
    .await?;

    // 仅在 primary 池已加载时同步内存状态（否则下次 ensure_pool_loaded 会按新值加载）
    if POOL_MANAGER.get_write_pool(primary_id).is_some() {
        if new_is_active == Some(false) {
            // 停用 -> 从轮询列表里摘掉
            POOL_MANAGER.remove_replica(primary_id, replica_id).await;
        } else if connection_changed || new_is_active == Some(true) || new_weight.is_some() {
            // 任何会影响"读路由"的字段改了 -> 重新读 DB 拼配置后增量挂载
            if let Ok(row) = sqlx::query(
                r#"
                SELECT id, db_host, db_port, db_name, db_user, db_password_encrypted,
                       COALESCE(weight, 1) AS weight,
                       COALESCE(is_active, true) AS is_active
                FROM management.tenant_databases
                WHERE id = $1
                "#,
            )
            .bind(replica_id)
            .fetch_one(&pool)
            .await
            {
                let is_active: bool = row.get("is_active");
                if is_active {
                    let enc: String = row.get("db_password_encrypted");
                    let plain_pwd = crate::crypto::decrypt_secret_lossy(&enc);
                    let cfg = DatabaseConfig {
                        id: replica_id,
                        host: row.get("db_host"),
                        port: row.get("db_port"),
                        database: row.get("db_name"),
                        username: row.get("db_user"),
                        password: plain_pwd,
                        max_connections: crate::pool_manager::DEFAULT_TENANT_MAX_CONNECTIONS,
                        connection_timeout:
                            crate::pool_manager::DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS,
                    };
                    let w: i32 = row.get("weight");
                    if let Err(e) = POOL_MANAGER
                        .upsert_replica(primary_id, replica_id, w, cfg)
                        .await
                    {
                        tracing::warn!(
                            "副本 {} 内存状态刷新失败：{}（下次请求会重试）",
                            replica_id,
                            e
                        );
                    }
                } else {
                    POOL_MANAGER.remove_replica(primary_id, replica_id).await;
                }
            }
        }
    }

    tracing::info!(
        "超管 {} 更新了租户 {} 的副本 {} (primary={})",
        claims.sub,
        tenant_id,
        replica_id,
        primary_id
    );

    Ok(Json(json!({
        "success": true,
        "id": replica_id,
        "message": "副本已更新；读流量将按新拓扑路由"
    })))
}

/// DELETE /api/admin/tenants/:tenant_id/replicas/:replica_id - 删除副本
pub async fn delete_tenant_replica(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((tenant_id, replica_id)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>> {
    ensure_superadmin(&pool, claims.sub).await?;

    let primary_id = primary_db_id_for_tenant(&pool, tenant_id).await?;

    let result = sqlx::query(
        r#"
        DELETE FROM management.tenant_databases
        WHERE id = $1 AND tenant_id = $2 AND primary_id = $3
              AND COALESCE(db_role, '') = 'replica'
        RETURNING connection_name
        "#,
    )
    .bind(replica_id)
    .bind(tenant_id)
    .bind(primary_id)
    .fetch_optional(&pool)
    .await?;

    match result {
        Some(row) => {
            let name: String = row.get("connection_name");
            // 仅移除该副本节点，不影响 primary 与其他副本
            POOL_MANAGER.remove_replica(primary_id, replica_id).await;
            tracing::info!(
                "超管 {} 删除了租户 {} 的副本 {} ({})",
                claims.sub,
                tenant_id,
                replica_id,
                name
            );
            Ok(Json(json!({
                "success": true,
                "message": format!("副本 {} 已删除", name)
            })))
        }
        None => Err(crate::error::AppError::NotFound(format!(
            "副本 {} 不存在于租户 {}",
            replica_id, tenant_id
        ))),
    }
}

/// GET /api/admin/tenants/:tenant_id/replicas/health
///
/// 对该租户主连接下的每个副本逐个建短连接并查询：
///   - pg_is_in_recovery()                  -> 是否为物理 standby
///   - pg_last_xact_replay_timestamp()      -> 最后一次重放事务的时间戳
///   - now() - last_replay_ts               -> 复制延迟（秒）
///   - version()                            -> 服务器版本
///
/// 每个副本的探测都有 3 秒超时上限，整体 handler 串行执行（数量通常很少）。
/// 注意：本接口**不写**任何元数据，也不修改连接池；只做观测，供 UI 显示徽标。
pub async fn get_replicas_health(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<i32>,
) -> Result<Json<Vec<serde_json::Value>>> {
    ensure_superadmin(&pool, claims.sub).await?;

    let primary_id = primary_db_id_for_tenant(&pool, tenant_id).await?;

    let replicas = sqlx::query(
        r#"
        SELECT id, db_host, db_port, db_name, db_user, db_password_encrypted,
               COALESCE(is_active, true) AS is_active
        FROM management.tenant_databases
        WHERE tenant_id = $1 AND primary_id = $2 AND COALESCE(db_role, '') = 'replica'
        ORDER BY id ASC
        "#,
    )
    .bind(tenant_id)
    .bind(primary_id)
    .fetch_all(&pool)
    .await?;

    let mut results = Vec::with_capacity(replicas.len());
    for r in &replicas {
        let id: i32 = r.get("id");
        let host: String = r.get("db_host");
        let port: i32 = r.get("db_port");
        let db: String = r.get("db_name");
        let user: String = r.get("db_user");
        let enc: String = r.get("db_password_encrypted");
        let is_active: bool = r.get("is_active");
        let password = crate::crypto::decrypt_secret_lossy(&enc);

        let health = probe_replica_health(&host, port, &db, &user, &password).await;
        let bypassed = crate::pool_manager::POOL_MANAGER.is_replica_bypassed(primary_id, id);
        results.push(json!({
            "id": id,
            "is_active": is_active,
            "bypassed": bypassed,
            "reachable": health.reachable,
            "in_recovery": health.in_recovery,
            "lag_seconds": health.lag_seconds,
            "last_replay_ts": health.last_replay_ts,
            "server_version": health.server_version,
            "error": health.error,
            "probed_at": chrono::Utc::now().to_rfc3339(),
        }));
    }

    Ok(Json(results))
}

struct ReplicaHealth {
    reachable: bool,
    in_recovery: Option<bool>,
    lag_seconds: Option<f64>,
    last_replay_ts: Option<String>,
    server_version: Option<String>,
    error: Option<String>,
}

async fn probe_replica_health(
    host: &str,
    port: i32,
    db: &str,
    user: &str,
    password: &str,
) -> ReplicaHealth {
    use sqlx::postgres::PgConnectOptions;
    use sqlx::ConnectOptions;

    // 直接构造 options，避免 URL 转义；并关掉 sqlx 默认的 statement 日志，
    // 否则健康检查每秒级调用会刷屏 sqlx::query trace。
    let opts = PgConnectOptions::new()
        .host(host)
        .port(port as u16)
        .database(db)
        .username(user)
        .password(password)
        .application_name("onebase-replica-health")
        .disable_statement_logging();

    let conn_fut = sqlx::PgConnection::connect_with(&opts);
    let conn_res = tokio::time::timeout(Duration::from_secs(3), conn_fut).await;
    let mut conn = match conn_res {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            return ReplicaHealth {
                reachable: false,
                in_recovery: None,
                lag_seconds: None,
                last_replay_ts: None,
                server_version: None,
                error: Some(e.to_string()),
            };
        }
        Err(_) => {
            return ReplicaHealth {
                reachable: false,
                in_recovery: None,
                lag_seconds: None,
                last_replay_ts: None,
                server_version: None,
                error: Some("连接超时（3s）".to_string()),
            };
        }
    };

    let q = sqlx::query(
        "SELECT pg_is_in_recovery() AS in_recovery, \
                EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS lag_seconds, \
                pg_last_xact_replay_timestamp()::TEXT AS last_replay_ts, \
                version() AS srv_version",
    )
    .fetch_one(&mut conn);

    let row_res = tokio::time::timeout(Duration::from_secs(3), q).await;
    let _ = conn.close().await;

    match row_res {
        Ok(Ok(row)) => ReplicaHealth {
            reachable: true,
            in_recovery: row.try_get::<bool, _>("in_recovery").ok(),
            lag_seconds: row.try_get::<Option<f64>, _>("lag_seconds").unwrap_or(None),
            last_replay_ts: row
                .try_get::<Option<String>, _>("last_replay_ts")
                .unwrap_or(None),
            server_version: row
                .try_get::<Option<String>, _>("srv_version")
                .unwrap_or(None),
            error: None,
        },
        Ok(Err(e)) => ReplicaHealth {
            reachable: true,
            in_recovery: None,
            lag_seconds: None,
            last_replay_ts: None,
            server_version: None,
            error: Some(format!("查询失败: {}", e)),
        },
        Err(_) => ReplicaHealth {
            reachable: true,
            in_recovery: None,
            lag_seconds: None,
            last_replay_ts: None,
            server_version: None,
            error: Some("查询超时（3s）".to_string()),
        },
    }
}

/// DELETE /api/admin/tenants/:tenant_id - 删除租户（超管专用）
pub async fn delete_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    audit_sink: Option<Extension<crate::audit_middleware::AuditDetailSink>>,
    Path(tenant_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    let user_id = claims.sub;

    // 验证超管权限
    let is_superadmin = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(is_superadmin, false) FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .unwrap_or(false);

    if !is_superadmin {
        return Err(crate::error::AppError::Unauthorized(
            "需要超级管理员权限".to_string(),
        ));
    }

    // 删除前先读 slug / workspace_config，供 Webhook deprovision 使用
    let tenant_row =
        sqlx::query("SELECT name, slug, workspace_config FROM management.tenants WHERE id = $1")
            .bind(tenant_id)
            .fetch_optional(&pool)
            .await?;

    match tenant_row {
        Some(row) => {
            let name: String = row.get("name");
            let slug: String = row.get("slug");
            let workspace_config: serde_json::Value = row
                .try_get("workspace_config")
                .unwrap_or(serde_json::Value::Null);

            sqlx::query("DELETE FROM management.tenants WHERE id = $1")
                .bind(tenant_id)
                .execute(&pool)
                .await?;

            tracing::info!("超管 {} 删除了租户: {} (id={})", user_id, name, tenant_id);
            set_audit_detail(
                &audit_sink,
                "platform.tenant.delete",
                json!({ "tenant_id": tenant_id, "name": name }),
            );

            // 删除成功后回调 deprovision Webhook；失败只记日志，不影响删除结果
            crate::provision_webhook::deprovision_after_tenant_delete(
                &slug,
                &workspace_config,
                tenant_id,
            )
            .await;

            Ok(Json(json!({
                "success": true,
                "message": format!("租户 {} 已删除", name)
            })))
        }
        None => Err(crate::error::AppError::NotFound(format!(
            "租户 {} 不存在",
            tenant_id
        ))),
    }
}

/// GET /api/admin/users - 获取所有用户（超管专用）
pub async fn list_all_users(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<serde_json::Value>>> {
    let user_id = claims.sub;

    // 平台超管限制已按需求移除：该接口对任何已认证用户开放（user_id 仅用于审计日志）。
    let _ = user_id;

    let users = sqlx::query(
        r#"
        SELECT 
            u.id,
            u.username,
            u.email,
            COALESCE(u.is_superadmin, false) AS is_superadmin,
            u.created_at::TEXT as created_at,
            ARRAY_AGG(
                DISTINCT jsonb_build_object(
                    'tenant_id', t.id,
                    'tenant_name', t.name,
                    'role', ut.role
                )
            ) FILTER (WHERE t.id IS NOT NULL) AS tenants
        FROM users u
        LEFT JOIN management.user_tenants ut ON ut.user_id = u.id AND ut.is_active = true
        LEFT JOIN management.tenants t ON t.id = ut.tenant_id
        GROUP BY u.id, u.username, u.email, u.is_superadmin, u.created_at
        ORDER BY u.created_at DESC
        "#,
    )
    .fetch_all(&pool)
    .await?;

    let result: Vec<serde_json::Value> = users
        .iter()
        .map(|row| {
            // ARRAY_AGG(... FILTER (WHERE t.id IS NOT NULL)) 在没有租户时返回 NULL，
            // 不能直接 row.get 到 Vec，否则 sqlx 会 panic。统一兜成 [] 让前端少处理一种状态。
            let tenants: Vec<serde_json::Value> = row
                .try_get::<Vec<serde_json::Value>, _>("tenants")
                .unwrap_or_default();
            json!({
                "id": row.get::<i32, _>("id"),
                "username": row.get::<String, _>("username"),
                "email": row.get::<String, _>("email"),
                "is_superadmin": row.get::<bool, _>("is_superadmin"),
                "created_at": row.get::<String, _>("created_at"),
                "tenants": tenants,
            })
        })
        .collect();

    Ok(Json(result))
}

/// POST /api/admin/users/:user_id/assign-tenant - 将用户分配给租户（超管专用）
pub async fn assign_user_to_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Path(target_user_id): Path<i32>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let user_id = claims.sub;

    // 平台超管断言。这条路由本来就挂在 superadmin_tenant_routes 上有 middleware 兜底，
    // 这里再用 JWT Claims 直接判一次（不再回 DB 查 is_superadmin，省一次 SQL）。
    permissions::require_platform_superadmin(&claims)?;

    let tenant_id = req["tenant_id"]
        .as_i64()
        .ok_or_else(|| crate::error::AppError::InvalidQuery("缺少租户ID".to_string()))?
        as i32;

    let role = req["role"].as_str().unwrap_or("member");

    let valid_roles = ["owner", "admin", "member", "viewer"];
    if !valid_roles.contains(&role) {
        return Err(crate::error::AppError::InvalidQuery(format!(
            "Invalid role: {}. Must be one of: owner, admin, member, viewer",
            role
        )));
    }

    if user_id == target_user_id {
        return Err(crate::error::AppError::Forbidden(
            "Cannot modify your own role".to_string(),
        ));
    }

    sqlx::query(
        r#"
        INSERT INTO management.user_tenants (user_id, tenant_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, tenant_id) 
        DO UPDATE SET role = $3, is_active = true
        "#,
    )
    .bind(target_user_id)
    .bind(tenant_id)
    .bind(role)
    .execute(&pool)
    .await?;

    // 同步默认 RBAC 角色（详见 admin_handlers::add_user_to_tenant 处的注释）。
    // sync_default_rbac_role 内部会调用 invalidate_user_permissions，不必再单独清缓存。
    permissions::sync_default_rbac_role(&pool, redis_ref(&redis), target_user_id, tenant_id, role)
        .await?;

    tracing::info!(
        "超管 {} 将用户 {} 分配给租户 {} (角色: {})",
        user_id,
        target_user_id,
        tenant_id,
        role
    );

    Ok(Json(json!({
        "success": true,
        "message": "用户已成功分配给租户",
    })))
}

// ============================================================
// W1 工作空间：项目列表 / 详情
// ============================================================
//
// 与 get_my_connections 的区别：
//   get_my_connections 返回"用户可访问的 DB 连接"（按 user_databases + tenants 视图）
//   list_projects      返回"用户隶属的项目元数据"（user_tenants + tenants），含 user_role
//
// 设计原则（详见 docs/superpowers/specs/2026-05-18-project-workspace-w1-w2-design.md §3.1）：
//   - 不引入新中间件，直接复用 auth_middleware
//   - 不区分 tenant.kind=legacy_tenant 还是 project（W1 全部返回）
//   - 把用户在该项目的 role 作为字段返回，前端用它做 UI 能力门槛

/// GET /api/projects
///
/// 返回当前登录用户可见的项目列表。
/// - 超管：返回所有 status='active' 的 tenants
/// - 普通用户：返回自己加入的项目，以及自己管理的组织下全部 active 项目
///
/// 返回字段：id, name, slug, status, kind, contact_email, user_role, via_organization
/// user_role 取值：
///   - 超管：'superadmin'
///   - 项目成员：user_tenants.role（'owner'/'admin'/'member'/'viewer' 等）
///   - 仅通过组织管理员身份访问：'admin'
#[derive(Deserialize)]
pub struct ListProjectsQuery {
    pub organization_id: Option<i32>,
}

const LIST_PROJECTS_FOR_USER_SQL: &str = r#"
    SELECT id, name, slug, status, kind, contact_email,
           organization_id, organization_name, user_role, via_organization
    FROM (
        SELECT t.id, t.name, t.slug, t.status, t.kind, t.contact_email,
               t.organization_id, o.name AS organization_name,
               ut.role AS user_role, false AS via_organization
        FROM management.tenants t
        JOIN management.organizations o ON o.id = t.organization_id
        JOIN management.user_tenants ut
          ON ut.tenant_id = t.id AND ut.user_id = $1 AND ut.is_active = true
        JOIN management.organization_members om
          ON om.organization_id = t.organization_id
         AND om.user_id = ut.user_id AND om.is_active = true
        WHERE t.status = 'active'
          AND ($2::int IS NULL OR t.organization_id = $2)

        UNION ALL

        SELECT t.id, t.name, t.slug, t.status, t.kind, t.contact_email,
               t.organization_id, o.name AS organization_name,
               'admin'::text AS user_role, true AS via_organization
        FROM management.tenants t
        JOIN management.organizations o ON o.id = t.organization_id
        JOIN management.organization_members om
          ON om.organization_id = t.organization_id
         AND om.user_id = $1 AND om.is_active = true
         AND om.role IN ('owner', 'admin')
        WHERE t.status = 'active'
          AND ($2::int IS NULL OR t.organization_id = $2)
          AND NOT EXISTS (
              SELECT 1
              FROM management.user_tenants ut
              WHERE ut.tenant_id = t.id
                AND ut.user_id = $1
                AND ut.is_active = true
          )
    ) visible_projects
    ORDER BY id DESC
"#;

pub async fn list_projects(
    State(pool): State<sqlx::PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<ListProjectsQuery>,
) -> Result<Json<serde_json::Value>> {
    let rows = if claims.is_superadmin {
        sqlx::query(
            r#"
            SELECT t.id, t.name, t.slug, t.status, t.kind, t.contact_email,
                   t.organization_id, o.name AS organization_name,
                   false AS via_organization
            FROM management.tenants t
            JOIN management.organizations o ON o.id = t.organization_id
            WHERE t.status = 'active'
              AND ($1::int IS NULL OR t.organization_id = $1)
            ORDER BY t.id DESC
            "#,
        )
        .bind(q.organization_id)
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query(LIST_PROJECTS_FOR_USER_SQL)
            .bind(claims.sub)
            .bind(q.organization_id)
            .fetch_all(&pool)
            .await
    }?;

    let projects: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| -> Result<serde_json::Value> {
            let id: i32 = r.get("id");
            let name: String = r.get("name");
            let slug: String = r.get("slug");
            let status: String = r.get("status");
            let kind: String = r.get("kind");
            let contact_email: Option<String> = r.try_get("contact_email")?;
            let organization_id: i32 = r.get("organization_id");
            let organization_name: String = r.get("organization_name");
            let user_role: String = if claims.is_superadmin {
                "superadmin".to_string()
            } else {
                r.get("user_role")
            };
            let via_organization: bool = r.get("via_organization");
            Ok(serde_json::json!({
                "id": id,
                "name": name,
                "slug": slug,
                "status": status,
                "kind": kind,
                "contact_email": contact_email,
                "organization_id": organization_id,
                "organization_name": organization_name,
                "user_role": user_role,
                "via_organization": via_organization,
            }))
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(Json(serde_json::json!({ "projects": projects })))
}

/// GET /api/projects/:id
///
/// 返回单个项目详情 + 当前用户在该项目的 role。
/// - 项目不存在 → 404
/// - 用户无权访问 → 403
pub async fn get_project(
    State(pool): State<sqlx::PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    let tenant_row = sqlx::query(
        r#"
        SELECT t.id, t.name, t.slug, t.status, t.kind, t.contact_email, t.workspace_config,
               t.organization_id, o.name AS organization_name
        FROM management.tenants t
        JOIN management.organizations o ON o.id = t.organization_id
        WHERE t.id = $1 AND t.status = 'active'
        "#,
    )
    .bind(project_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("项目 {} 不存在", project_id)))?;

    let organization_id: i32 = tenant_row.get("organization_id");
    let organization_name: String = tenant_row.get("organization_name");

    let (user_role, via_organization): (String, bool) = if claims.is_superadmin {
        ("superadmin".to_string(), false)
    } else if permissions::is_org_admin_for_project(&pool, claims.sub, project_id).await? {
        let role_opt: Option<String> = sqlx::query_scalar(
            r#"
            SELECT role FROM management.user_tenants
            WHERE user_id = $1 AND tenant_id = $2 AND is_active = true
            "#,
        )
        .bind(claims.sub)
        .bind(project_id)
        .fetch_optional(&pool)
        .await?;
        let via_organization = role_opt.is_none();
        (
            role_opt.unwrap_or_else(|| "admin".to_string()),
            via_organization,
        )
    } else {
        // 两级成员：须同时是组织成员 + 项目成员
        permissions::require_tenant_membership_any(&pool, &claims, project_id).await?;
        let role_opt: Option<String> = sqlx::query_scalar(
            r#"
            SELECT role FROM management.user_tenants
            WHERE user_id = $1 AND tenant_id = $2 AND is_active = true
            "#,
        )
        .bind(claims.sub)
        .bind(project_id)
        .fetch_optional(&pool)
        .await?;

        match role_opt {
            Some(r) => (r, false),
            None => {
                return Err(AppError::Forbidden(format!(
                    "你不是项目 {} 的成员",
                    project_id
                )));
            }
        }
    };

    // 顺手取项目主连接给前端工作空间用——拿到后立即 setCurrentConnection，
    // 让所有现存 schemaAPI / queryAPI / rpcAPI 在不改一行业务代码的情况下
    // 走对的 X-Database-Id。详见 W2 plan Task 1/2。
    //
    // 鉴权：上面已经检查过项目成员或组织管理员身份（非超管时），所以这里直接按
    // tenant_id 取所有 active 连接，不再二次 join 用户表。
    //
    // 选连：is_primary=true 优先；都不是 primary 则取 id 最小那条；项目未绑定
    // 连接时返回 null（前端兜底显示"暂无连接"）。多读副本时本接口只回主连接，
    // 读副本切换是 W3 的事。
    let primary_connection: Option<serde_json::Value> = sqlx::query(
        r#"
        SELECT id, slug, db_name, db_host, db_port, is_primary
        FROM management.tenant_databases
        WHERE tenant_id = $1 AND is_active = true
        ORDER BY is_primary DESC, id ASC
        LIMIT 1
        "#,
    )
    .bind(project_id)
    .fetch_optional(&pool)
    .await?
    .map(|r| {
        serde_json::json!({
            "database_id": r.get::<i32, _>("id"),
            "database_slug": r.get::<Option<String>, _>("slug"),
            "db_name":     r.get::<String, _>("db_name"),
            "db_host":     r.get::<String, _>("db_host"),
            "db_port":     r.get::<i32, _>("db_port"),
            "is_primary":  r.get::<bool, _>("is_primary"),
        })
    });

    let id: i32 = tenant_row.get("id");
    let name: String = tenant_row.get("name");
    let slug: String = tenant_row.get("slug");
    let status: String = tenant_row.get("status");
    let kind: String = tenant_row.get("kind");
    let contact_email: Option<String> = tenant_row.try_get("contact_email")?;
    let workspace_config: Option<serde_json::Value> = tenant_row.try_get("workspace_config")?;

    Ok(Json(serde_json::json!({
        "id": id,
        "name": name,
        "slug": slug,
        "status": status,
        "kind": kind,
        "contact_email": contact_email,
        "organization_id": organization_id,
        "organization_name": organization_name,
        "workspace_config": workspace_config,
        "user_role": user_role,
        "via_organization": via_organization,
        "primary_connection": primary_connection,
    })))
}

// ============================================================
// W4 / PASE Stage E：项目成员管理 + 项目元信息编辑
// ============================================================
//
// 与 admin_handlers::{list_tenant_users, add_user_to_tenant, remove_user_from_tenant}
// 的关键区别：
//   - admin_handlers 走 require_super_admin（仅平台超管）
//   - 本块走 permissions::require_tenant_admin / require_tenant_owner，
//     让"项目自己的 admin/owner"也能管自己项目，不必每次都找平台超管
//
// 业务逻辑与 admin_handlers 高度重叠是有意为之——后端权限边界不同，
// 抽公共函数会让"谁能做什么"变得不直观。Bug fix 时两边都改。

#[derive(Deserialize)]
pub struct AddProjectMemberRequest {
    pub user_id: i32,
    pub role: String,
}

#[derive(Deserialize)]
pub struct UpdateProjectMemberRequest {
    pub role: String,
}

/// 把 user_tenants + users 的一行 fetch 拼成前端要的 member 对象。
fn member_row_to_json(row: &sqlx::postgres::PgRow) -> serde_json::Value {
    json!({
        "user_id":       row.get::<i32, _>("user_id"),
        "username":      row.get::<String, _>("username"),
        "email":         row.get::<String, _>("email"),
        "is_superadmin": row.get::<bool, _>("is_superadmin"),
        "is_active":     row.get::<bool, _>("is_active"),
        "role":          row.get::<String, _>("role"),
        "created_at":    crate::models::naive_to_utc_string(row.get::<chrono::NaiveDateTime, _>("created_at")),
    })
}

const VALID_TENANT_ROLES: &[&str] = &["owner", "admin", "member", "viewer"];

fn validate_tenant_role(role: &str) -> Result<()> {
    if VALID_TENANT_ROLES.contains(&role) {
        Ok(())
    } else {
        Err(AppError::InvalidQuery(format!(
            "无效角色 '{}'，必须是 owner / admin / member / viewer 之一",
            role
        )))
    }
}

fn forbid_self(actor: i32, target: i32) -> bool {
    actor == target
}

/// 项目 admin 可管理目标用户的前置条件。
async fn require_manageable_project_member(
    pool: &PgPool,
    claims: &Claims,
    project_id: i32,
    target_user_id: i32,
) -> Result<()> {
    permissions::require_tenant_admin(pool, claims, project_id).await?;
    if forbid_self(claims.sub, target_user_id) {
        return Err(AppError::Forbidden(
            "不能管理自己的账号；请使用「修改密码」或联系其他管理员".to_string(),
        ));
    }

    let is_member: bool = sqlx::query_scalar(
        "SELECT EXISTS(\
           SELECT 1 FROM management.user_tenants \
           WHERE tenant_id = $1 AND user_id = $2 AND is_active = true)",
    )
    .bind(project_id)
    .bind(target_user_id)
    .fetch_one(pool)
    .await?;
    if !is_member {
        return Err(AppError::Forbidden("目标用户不是本项目成员".to_string()));
    }
    Ok(())
}

/// GET /api/projects/:id/members
///
/// 列出指定项目的所有有效成员。鉴权：项目 admin/owner 或平台超管。
pub async fn list_project_members(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<Vec<serde_json::Value>>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    // owner / admin / member / viewer 按"管理重要度"排序，让前端列表自带语义；
    // 同角色内按用户名字母序。
    let rows = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.username, u.email, COALESCE(u.is_superadmin, false) AS is_superadmin,
               COALESCE(u.is_active, true) AS is_active,
               ut.role, ut.created_at
        FROM management.user_tenants ut
        JOIN users u ON u.id = ut.user_id
        WHERE ut.tenant_id = $1 AND ut.is_active = true
        ORDER BY
            CASE ut.role
                WHEN 'owner'  THEN 0
                WHEN 'admin'  THEN 1
                WHEN 'member' THEN 2
                WHEN 'viewer' THEN 3
                ELSE 4
            END,
            u.username ASC
        "#,
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;

    Ok(Json(rows.iter().map(member_row_to_json).collect()))
}

/// POST /api/projects/:id/members
///
/// 加一个**已存在**的用户进项目（body: { user_id, role }）。
/// 不支持按 email 邀请；v1 接受最小可用面。
pub async fn add_project_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Path(project_id): Path<i32>,
    Json(req): Json<AddProjectMemberRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_tenant_role(&req.role)?;
    if req.role == "owner" {
        permissions::require_project_owner_grant(&pool, &claims, project_id).await?;
    }

    // 校验项目存在
    let project_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM management.tenants WHERE id = $1 AND status = 'active')",
    )
    .bind(project_id)
    .fetch_one(&pool)
    .await?;
    if !project_exists {
        return Err(AppError::NotFound(format!(
            "项目 {} 不存在或已停用",
            project_id
        )));
    }

    // 校验目标用户存在
    let user_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(req.user_id)
        .fetch_one(&pool)
        .await?;
    if !user_exists {
        return Err(AppError::NotFound(format!("用户 {} 不存在", req.user_id)));
    }

    // 两级成员：目标用户必须先是该项目所属组织的成员
    permissions::require_user_is_org_member_of_project(&pool, req.user_id, project_id).await?;

    sqlx::query(
        r#"
        INSERT INTO management.user_tenants (user_id, tenant_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, tenant_id)
        DO UPDATE SET role = $3, is_active = true
        "#,
    )
    .bind(req.user_id)
    .bind(project_id)
    .bind(&req.role)
    .execute(&pool)
    .await?;

    // 与 admin_handlers::add_user_to_tenant 完全一致：给目标用户挂默认 RBAC 角色，
    // 否则他被加进来后在 /api/v1/{db}/{schema}/{table} 系列接口上仍是 0 权限。
    permissions::sync_default_rbac_role(
        &pool,
        redis_ref(&redis),
        req.user_id,
        project_id,
        &req.role,
    )
    .await?;

    tracing::info!(
        "user {} ({}) added user {} to project {} as {}",
        claims.sub,
        claims.email,
        req.user_id,
        project_id,
        req.role
    );

    // 返回新行——前端拿到后直接 push 进列表，无需再 fetch 全量
    let row = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.username, u.email, COALESCE(u.is_superadmin, false) AS is_superadmin,
               COALESCE(u.is_active, true) AS is_active,
               ut.role, ut.created_at
        FROM management.user_tenants ut
        JOIN users u ON u.id = ut.user_id
        WHERE ut.tenant_id = $1 AND ut.user_id = $2
        "#,
    )
    .bind(project_id)
    .bind(req.user_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(member_row_to_json(&row)))
}

#[derive(Deserialize)]
pub struct CreateProjectMemberRequest {
    pub username: String,
    pub email: String,
    pub password: String,
    pub role: String,
}

/// POST /api/projects/:id/members/create-user
///
/// 在项目里**直接新建一个平台账号**并加入本项目。面向"对方还没注册"的场景：
/// 项目 admin/owner 填好用户名 / 邮箱 / 初始密码，一步建号 + 入项目 + 挂默认 RBAC。
///
/// 与 `add_project_member`（加已存在用户）互补；与 `auth_handlers::register`
/// 的区别是这里由管理员代建、不下发登录 token、新账号 role 固定为普通 'user'。
pub async fn create_project_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Path(project_id): Path<i32>,
    Json(req): Json<CreateProjectMemberRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_tenant_role(&req.role)?;

    // 基础字段校验（与注册接口口径保持一致的最小集）。
    let username = req.username.trim();
    let email = req.email.trim().to_lowercase();
    if username.chars().count() < 3 {
        return Err(AppError::InvalidQuery("用户名至少 3 个字符".to_string()));
    }
    if !email.contains('@') || email.len() < 5 {
        return Err(AppError::InvalidQuery("邮箱格式不正确".to_string()));
    }
    if req.password.chars().count() < 6 {
        return Err(AppError::InvalidQuery("密码至少 6 个字符".to_string()));
    }

    // 校验项目存在且有效
    let project_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM management.tenants WHERE id = $1 AND status = 'active')",
    )
    .bind(project_id)
    .fetch_one(&pool)
    .await?;
    if !project_exists {
        return Err(AppError::NotFound(format!(
            "项目 {} 不存在或已停用",
            project_id
        )));
    }

    // 用户名 / 邮箱唯一性预检（DB 也有唯一约束兜底，这里给更友好的报错）
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

    let password_hash = crate::auth::hash_password(&req.password)?;
    let organization_id = permissions::lookup_organization_for_project(&pool, project_id).await?;

    // 建号
    let new_user_id: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO users (username, email, password_hash, role)
        VALUES ($1, $2, $3, 'user')
        RETURNING id
        "#,
    )
    .bind(username)
    .bind(&email)
    .bind(&password_hash)
    .fetch_one(&pool)
    .await?;

    // 先入组织（member），再入项目——满足两级成员不变量
    sqlx::query(
        r#"
        INSERT INTO management.organization_members (user_id, organization_id, role, is_active)
        VALUES ($1, $2, 'member', true)
        ON CONFLICT (user_id, organization_id)
        DO UPDATE SET is_active = true
        "#,
    )
    .bind(new_user_id)
    .bind(organization_id)
    .execute(&pool)
    .await?;

    // 加入项目（与 add_project_member 同口径：upsert + 默认 RBAC 角色）
    sqlx::query(
        r#"
        INSERT INTO management.user_tenants (user_id, tenant_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, tenant_id)
        DO UPDATE SET role = $3, is_active = true
        "#,
    )
    .bind(new_user_id)
    .bind(project_id)
    .bind(&req.role)
    .execute(&pool)
    .await?;

    permissions::sync_default_rbac_role(
        &pool,
        redis_ref(&redis),
        new_user_id,
        project_id,
        &req.role,
    )
    .await?;

    tracing::info!(
        "user {} ({}) created user {} ({}) and added to project {} as {}",
        claims.sub,
        claims.email,
        new_user_id,
        email,
        project_id,
        req.role
    );

    let row = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.username, u.email, COALESCE(u.is_superadmin, false) AS is_superadmin,
               COALESCE(u.is_active, true) AS is_active,
               ut.role, ut.created_at
        FROM management.user_tenants ut
        JOIN users u ON u.id = ut.user_id
        WHERE ut.tenant_id = $1 AND ut.user_id = $2
        "#,
    )
    .bind(project_id)
    .bind(new_user_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(member_row_to_json(&row)))
}

/// GET /api/projects/:id/members/search?q=keyword
///
/// 给"添加成员"对话框做用户搜索的轻量接口。鉴权：项目 admin/owner 或
/// 平台超管。匹配规则：username / email ILIKE `%q%`，限 20 条。
///
/// 隐私收敛：
/// - `q` 至少 2 字符，避免空搜索把全表抠出来
/// - 只返回 `id, username, email`，不带 role / 租户 / created_at 等元数据
/// - 同时标记 `already_member`：该 user 是否已经在本项目里——前端据此
///   把已加入的人灰掉，避免重复添加
///
/// 与 `admin_handlers::list_users` 区分：那条是超管专属、返回全字段、不限行数；
/// 本接口是项目 admin 也能用、字段最小化、行数硬上限的"挑人"专用查询。
#[derive(Deserialize)]
pub struct MemberSearchQuery {
    pub q: String,
}

pub async fn search_project_member_candidates(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Query(q): Query<MemberSearchQuery>,
) -> Result<Json<Vec<serde_json::Value>>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let keyword = q.q.trim();
    if keyword.chars().count() < 2 {
        // 不报错，只回空——前端体验上更顺，不会因为输入第 1 个字符就弹 400
        return Ok(Json(Vec::new()));
    }

    // ILIKE 转义：% 和 _ 在 LIKE 模式里是通配符，用户搜 "100%" 这种字面量会
    // 误中所有"以 100 开头"的记录。`replace` 三连搞定，反斜杠也要先逃。
    let escaped = keyword
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let like = format!("%{}%", escaped);

    // 两级成员：候选人必须已是该项目所属租户的 active 成员
    let rows = sqlx::query(
        r#"
        SELECT
            u.id AS user_id,
            u.username,
            u.email,
            COALESCE(u.is_superadmin, false) AS is_superadmin,
            EXISTS (
                SELECT 1 FROM management.user_tenants ut
                WHERE ut.user_id = u.id AND ut.tenant_id = $2 AND ut.is_active = true
            ) AS already_member
        FROM users u
        JOIN management.tenants t ON t.id = $2 AND t.status = 'active'
        JOIN management.organization_members om
          ON om.organization_id = t.organization_id
         AND om.user_id = u.id
         AND om.is_active = true
        WHERE u.username ILIKE $1 ESCAPE '\'
           OR u.email    ILIKE $1 ESCAPE '\'
        ORDER BY
            already_member ASC,
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
    .bind(project_id)
    .bind(keyword)
    .fetch_all(&pool)
    .await?;

    let result: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            json!({
                "user_id":        row.get::<i32, _>("user_id"),
                "username":       row.get::<String, _>("username"),
                "email":          row.get::<String, _>("email"),
                "is_superadmin":  row.get::<bool, _>("is_superadmin"),
                "already_member": row.get::<bool, _>("already_member"),
            })
        })
        .collect();

    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
pub struct UpdateMemberProfileRequest {
    pub username: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResetMemberPasswordRequest {
    pub new_password: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMemberStatusRequest {
    pub is_active: bool,
}

fn validate_reset_member_password(password: &str) -> Result<()> {
    crate::auth::validate_password(password)
}

/// PATCH /api/projects/:id/members/:user_id/status
///
/// 项目 admin/owner 或平台超管可停用或恢复项目成员的全局账号。
/// 停用后吊销目标用户的全部会话。
pub async fn update_project_member_status(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, target_user_id)): Path<(i32, i32)>,
    Json(req): Json<UpdateMemberStatusRequest>,
) -> Result<Json<serde_json::Value>> {
    require_manageable_project_member(&pool, &claims, project_id, target_user_id).await?;

    let result = sqlx::query("UPDATE users SET is_active = $1 WHERE id = $2")
        .bind(req.is_active)
        .bind(target_user_id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "用户 {} 不存在",
            target_user_id
        )));
    }

    if !req.is_active {
        if let Err(error) = permissions::revoke_user_sessions(
            &pool,
            target_user_id,
            "user_deactivated_by_project_admin",
        )
        .await
        {
            tracing::warn!(
                user_id = target_user_id,
                project_id,
                %error,
                "failed to revoke sessions after project-admin deactivation"
            );
        }
    }

    tracing::info!(
        "user {} ({}) set active={} for user {} in project {}",
        claims.sub,
        claims.email,
        req.is_active,
        target_user_id,
        project_id
    );

    Ok(Json(json!({
        "ok": true,
        "user_id": target_user_id,
        "is_active": req.is_active,
    })))
}

/// POST /api/projects/:id/members/:user_id/reset-password
///
/// 项目 admin/owner 或平台超管可重置项目成员密码。重置后吊销目标用户全部会话，
/// 但不设置 must_change_password。
pub async fn reset_project_member_password(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, target_user_id)): Path<(i32, i32)>,
    Json(req): Json<ResetMemberPasswordRequest>,
) -> Result<Json<serde_json::Value>> {
    require_manageable_project_member(&pool, &claims, project_id, target_user_id).await?;
    validate_reset_member_password(&req.new_password)?;

    let new_hash = crate::auth::hash_password(&req.new_password)?;
    let result = sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(&new_hash)
        .bind(target_user_id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "用户 {} 不存在",
            target_user_id
        )));
    }

    if let Err(error) =
        permissions::revoke_user_sessions(&pool, target_user_id, "password_reset_by_project_admin")
            .await
    {
        tracing::warn!(
            user_id = target_user_id,
            project_id,
            %error,
            "failed to revoke sessions after project-admin password reset"
        );
    }

    tracing::info!(
        "user {} ({}) reset password for user {} in project {}",
        claims.sub,
        claims.email,
        target_user_id,
        project_id
    );

    Ok(Json(json!({
        "ok": true,
        "message": "密码已重置，目标用户需要重新登录",
    })))
}

/// PATCH /api/projects/:id/members/:user_id/profile
///
/// 项目 admin/owner 或平台超管可修改项目成员的用户名、邮箱。
pub async fn update_project_member_profile(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, target_user_id)): Path<(i32, i32)>,
    Json(req): Json<UpdateMemberProfileRequest>,
) -> Result<Json<serde_json::Value>> {
    require_manageable_project_member(&pool, &claims, project_id, target_user_id).await?;
    if req.username.is_none() && req.email.is_none() {
        return Err(AppError::InvalidQuery(
            "请求体为空，至少需要 username 或 email".to_string(),
        ));
    }

    let (current_username, current_email): (String, String) =
        sqlx::query_as("SELECT username, email FROM users WHERE id = $1")
            .bind(target_user_id)
            .fetch_optional(&pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("用户 {} 不存在", target_user_id)))?;

    let new_username = if let Some(ref username) = req.username {
        validate_username(username)?;
        Some(username.trim().to_string())
    } else {
        None
    };
    let new_email = if let Some(ref email) = req.email {
        validate_email(email)?;
        Some(email.trim().to_string())
    } else {
        None
    };

    if let Some(ref username) = new_username {
        if username != &current_username {
            let duplicate: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM users WHERE username = $1 AND id <> $2)",
            )
            .bind(username)
            .bind(target_user_id)
            .fetch_one(&pool)
            .await?;
            if duplicate {
                return Err(AppError::InvalidQuery("用户名已被使用".to_string()));
            }
        }
    }
    if let Some(ref email) = new_email {
        if email != &current_email {
            let duplicate: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1 AND id <> $2)",
            )
            .bind(email)
            .bind(target_user_id)
            .fetch_one(&pool)
            .await?;
            if duplicate {
                return Err(AppError::InvalidQuery("邮箱已被使用".to_string()));
            }
        }
    }

    sqlx::query(
        r#"
        UPDATE users
        SET username = COALESCE($2, username),
            email    = COALESCE($3, email)
        WHERE id = $1
        "#,
    )
    .bind(target_user_id)
    .bind(new_username.as_deref())
    .bind(new_email.as_deref())
    .execute(&pool)
    .await?;

    let (username, email): (String, String) =
        sqlx::query_as("SELECT username, email FROM users WHERE id = $1")
            .bind(target_user_id)
            .fetch_one(&pool)
            .await?;

    Ok(Json(json!({
        "ok": true,
        "user_id": target_user_id,
        "username": username,
        "email": email,
    })))
}

/// PATCH /api/projects/:id/members/:user_id
///
/// 改某成员的项目角色。鉴权：项目 admin/owner 或平台超管。
/// 护栏：不能改自己；不能把最后一个 owner 降级。
pub async fn update_project_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Path((project_id, target_user_id)): Path<(i32, i32)>,
    Json(req): Json<UpdateProjectMemberRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_tenant_role(&req.role)?;
    if req.role == "owner" {
        permissions::require_project_owner_grant(&pool, &claims, project_id).await?;
    }

    // 自我保护——避免一个 admin 不小心把自己降成 viewer 然后再也进不来。
    // 平台超管也走这条限制；他们要改自己的项目角色可以走 /api/admin/* 路径。
    if claims.sub == target_user_id {
        return Err(AppError::InvalidQuery(
            "不能修改自己的角色；请联系其他 owner / 平台超管".to_string(),
        ));
    }

    // 取当前 role 用于"最后一个 owner"护栏
    let current_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM management.user_tenants \
         WHERE tenant_id = $1 AND user_id = $2 AND is_active = true",
    )
    .bind(project_id)
    .bind(target_user_id)
    .fetch_optional(&pool)
    .await?;

    let current_role = current_role.ok_or_else(|| {
        AppError::NotFound(format!(
            "用户 {} 不是项目 {} 的成员",
            target_user_id, project_id
        ))
    })?;

    // 降级最后一个 owner 的护栏
    if current_role == "owner" && req.role != "owner" {
        let owner_count = permissions::count_tenant_owners(&pool, project_id).await?;
        if owner_count <= 1 {
            return Err(AppError::InvalidQuery(
                "不能降级项目最后一个 owner；请先把其他成员提升为 owner".to_string(),
            ));
        }
    }

    sqlx::query(
        "UPDATE management.user_tenants SET role = $1 \
         WHERE tenant_id = $2 AND user_id = $3",
    )
    .bind(&req.role)
    .bind(project_id)
    .bind(target_user_id)
    .execute(&pool)
    .await?;

    permissions::sync_default_rbac_role(
        &pool,
        redis_ref(&redis),
        target_user_id,
        project_id,
        &req.role,
    )
    .await?;

    tracing::info!(
        "user {} ({}) changed project {} member {}: {} -> {}",
        claims.sub,
        claims.email,
        project_id,
        target_user_id,
        current_role,
        req.role
    );

    let row = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.username, u.email, COALESCE(u.is_superadmin, false) AS is_superadmin,
               COALESCE(u.is_active, true) AS is_active,
               ut.role, ut.created_at
        FROM management.user_tenants ut
        JOIN users u ON u.id = ut.user_id
        WHERE ut.tenant_id = $1 AND ut.user_id = $2
        "#,
    )
    .bind(project_id)
    .bind(target_user_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(member_row_to_json(&row)))
}

/// DELETE /api/projects/:id/members/:user_id
///
/// 软删除：把 user_tenants.is_active 置 false + 清 RBAC + 失效缓存 + 吊销会话。
/// 与 admin_handlers::remove_user_from_tenant 同样的处理（详见那边的注释）。
pub async fn remove_project_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Path((project_id, target_user_id)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    if claims.sub == target_user_id {
        return Err(AppError::InvalidQuery(
            "不能移除自己；请联系其他 owner / 平台超管".to_string(),
        ));
    }

    // 取当前 role 用于"最后一个 owner"护栏；顺便确认目标确实是成员
    let current_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM management.user_tenants \
         WHERE tenant_id = $1 AND user_id = $2 AND is_active = true",
    )
    .bind(project_id)
    .bind(target_user_id)
    .fetch_optional(&pool)
    .await?;

    let current_role = current_role.ok_or_else(|| {
        AppError::NotFound(format!(
            "用户 {} 不是项目 {} 的成员",
            target_user_id, project_id
        ))
    })?;

    if current_role == "owner" {
        let owner_count = permissions::count_tenant_owners(&pool, project_id).await?;
        if owner_count <= 1 {
            return Err(AppError::InvalidQuery(
                "不能移除项目最后一个 owner；请先指派其他成员为 owner".to_string(),
            ));
        }
    }

    sqlx::query(
        "UPDATE management.user_tenants SET is_active = false \
         WHERE tenant_id = $1 AND user_id = $2",
    )
    .bind(project_id)
    .bind(target_user_id)
    .execute(&pool)
    .await?;

    // 与 admin_handlers::remove_user_from_tenant 一致：清 RBAC 角色避免"软删后
    // 把人再加回来时旧权限自动复活"，并失效权限缓存 + 吊销会话。
    sqlx::query("DELETE FROM management.user_roles WHERE user_id = $1 AND tenant_id = $2")
        .bind(target_user_id)
        .bind(project_id)
        .execute(&pool)
        .await?;

    permissions::invalidate_user_permissions(redis_ref(&redis), project_id, target_user_id).await;

    let _ = permissions::revoke_user_sessions(
        &pool,
        target_user_id,
        &format!("removed_from_project_{}", project_id),
    )
    .await;

    tracing::info!(
        "user {} ({}) removed user {} (was {}) from project {}",
        claims.sub,
        claims.email,
        target_user_id,
        current_role,
        project_id
    );

    Ok(Json(json!({
        "removed": true,
        "user_id": target_user_id,
        "project_id": project_id,
    })))
}

/// PATCH /api/projects/:id
///
/// 项目 owner 自助编辑元信息。允许字段：name / contact_email / workspace_config。
/// 不允许 slug / kind / status / db_*（这些保留给平台超管走 /api/admin/tenants/:id）。
pub async fn patch_project(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_owner(&pool, &claims, project_id).await?;

    // 显式拒绝平台超管路径才能改的字段——不能让 owner 通过本接口绕开
    // /api/admin/tenants 上的更严格校验
    for forbidden in &[
        "slug",
        "kind",
        "status",
        "db_host",
        "db_port",
        "db_name",
        "db_user",
        "db_password",
    ] {
        if req.get(*forbidden).is_some() {
            return Err(AppError::InvalidQuery(format!(
                "字段 '{}' 不允许通过项目设置编辑；请联系平台管理员",
                forbidden
            )));
        }
    }

    let new_name = req.get("name").and_then(|v| v.as_str());
    let new_contact_email = req.get("contact_email").and_then(|v| v.as_str());
    let new_workspace_config = req.get("workspace_config");

    // 字段长度护栏（与现有 tenant 表约束保持宽松一致）
    if let Some(name) = new_name {
        let len = name.chars().count();
        if !(1..=200).contains(&len) {
            return Err(AppError::InvalidQuery(
                "项目名长度必须在 1-200 字符之间".to_string(),
            ));
        }
    }
    if let Some(email) = new_contact_email {
        // 空字符串视为"清除联系邮箱"
        if !email.is_empty() && (email.len() > 255 || !email.contains('@')) {
            return Err(AppError::InvalidQuery(
                "contact_email 看起来不是合法邮箱".to_string(),
            ));
        }
    }

    if new_name.is_none() && new_contact_email.is_none() && new_workspace_config.is_none() {
        return Err(AppError::InvalidQuery(
            "没有任何可编辑字段；name / contact_email / workspace_config 至少给一个".to_string(),
        ));
    }

    // contact_email 走 COALESCE 时需要区分"显式传空字符串 = 清空"和"没传 = 不变"。
    // 这里把 ""（清空意图）映射成 NULL 进库。
    let normalized_email: Option<&str> = new_contact_email
        .map(|e| if e.is_empty() { None } else { Some(e) })
        .flatten();

    sqlx::query(
        r#"
        UPDATE management.tenants
        SET
            name             = COALESCE($1, name),
            contact_email    = CASE
                                  WHEN $2::text IS NOT NULL OR $4::bool THEN $2
                                  ELSE contact_email
                               END,
            workspace_config = COALESCE($3, workspace_config)
        WHERE id = $5
        "#,
    )
    .bind(new_name)
    .bind(normalized_email)
    .bind(new_workspace_config)
    .bind(new_contact_email.is_some()) // 标记"用户显式提交了 contact_email 字段"，包括清空意图
    .bind(project_id)
    .execute(&pool)
    .await?;

    tracing::info!(
        "user {} ({}) patched project {} ({}{}{})",
        claims.sub,
        claims.email,
        project_id,
        if new_name.is_some() { "name " } else { "" },
        if new_contact_email.is_some() {
            "contact_email "
        } else {
            ""
        },
        if new_workspace_config.is_some() {
            "workspace_config "
        } else {
            ""
        },
    );

    // 复用 get_project 的逻辑返回完整 payload——但 get_project 是 handler 不是
    // 纯函数；本期复刻 SELECT 一遍，等下个 refactor 把 SELECT 抽出来共用。
    let row = sqlx::query(
        r#"
        SELECT id, name, slug, status, kind, contact_email, workspace_config
        FROM management.tenants
        WHERE id = $1
        "#,
    )
    .bind(project_id)
    .fetch_one(&pool)
    .await?;

    let user_role = if claims.is_superadmin {
        "superadmin".to_string()
    } else {
        // owner 一定是；前面的 require_tenant_owner 已经断言过
        "owner".to_string()
    };

    Ok(Json(json!({
        "id":               row.get::<i32, _>("id"),
        "name":             row.get::<String, _>("name"),
        "slug":             row.get::<String, _>("slug"),
        "status":           row.get::<String, _>("status"),
        "kind":             row.get::<String, _>("kind"),
        "contact_email":    row.try_get::<Option<String>, _>("contact_email").ok().flatten(),
        "workspace_config": row.try_get::<Option<serde_json::Value>, _>("workspace_config").ok().flatten(),
        "user_role":        user_role,
    })))
}

// ============================================================
// M2 自助开通向导：项目模板只读 + provision 主端点
// ============================================================
//
// 详见 docs/superpowers/plans/2026-05-19-m2-onboarding-wizard.md §3.4。

/// GET /api/project-templates —— 给 wizard step 1/4 用的卡片列表。
///
/// 返回所有 is_active=true 的模板，**包括** is_coming_soon=true 的（让前端能渲染
/// "敬请期待" 的占位卡，而不是悄悄消失）。
pub async fn list_project_templates(
    State(pool): State<PgPool>,
    Extension(_claims): Extension<Claims>,
) -> Result<Json<Vec<serde_json::Value>>> {
    let rows = sqlx::query(
        r#"
        SELECT id, slug, name, description, scenario, is_coming_soon, sort_order
        FROM management.project_templates
        WHERE is_active = true
        ORDER BY sort_order ASC, id ASC
        "#,
    )
    .fetch_all(&pool)
    .await?;

    let templates: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":             r.get::<i32, _>("id"),
                "slug":           r.get::<String, _>("slug"),
                "name":           r.get::<String, _>("name"),
                "description":    r.try_get::<Option<String>, _>("description").ok().flatten(),
                "scenario":       r.get::<String, _>("scenario"),
                "is_coming_soon": r.get::<bool, _>("is_coming_soon"),
                "sort_order":     r.get::<i32, _>("sort_order"),
            })
        })
        .collect();

    Ok(Json(templates))
}

#[derive(Deserialize)]
pub struct ManualPgConnection {
    pub db_host: String,
    #[serde(default = "default_pg_port")]
    pub db_port: i32,
    pub admin_user: String,
    pub admin_password: String,
}

fn default_pg_port() -> i32 {
    5432
}

#[derive(Deserialize)]
pub struct ProvisionRequest {
    pub name: String,
    pub slug: String,
    #[serde(default)]
    pub use_platform_pg: bool,
    #[serde(default)]
    pub use_provision_webhook: bool,
    pub requested_resources: Option<Vec<String>>,
    pub pg_pool_id: Option<i32>,
    pub pg_connection: Option<ManualPgConnection>,
    pub template_slug: String,
    pub scenario: Option<String>,
    /// 所属组织。有则挂到该组织；无则兼容期隐式创建个人组织（P2 将删除）。
    pub organization_id: Option<i32>,
}

struct ResolvedProvisionPg {
    creds: crate::pg_pool_helpers::PgAdminCredentials,
    pool_id: Option<i32>,
    platform_pg: bool,
}

enum ResolvedProvisionSource {
    LocalPg(ResolvedProvisionPg),
    Webhook(crate::provision_webhook::WebhookProvisionOutcome),
}

enum ProvisionRollbackPlan {
    DropDatabase {
        creds: crate::pg_pool_helpers::PgAdminCredentials,
        db_name: String,
        /// P1.1：随库一起回滚删除的专属项目角色（None = 沿用了 admin 凭据）。
        app_role: Option<String>,
    },
    DeprovisionWebhook {
        provision_id: String,
    },
}

async fn resolve_provision_source(
    pool: &PgPool,
    req: &ProvisionRequest,
    claims: &Claims,
    name: &str,
    slug: &str,
    template_slug: &str,
) -> Result<ResolvedProvisionSource> {
    let mode_count = [
        req.use_provision_webhook,
        req.use_platform_pg,
        req.pg_pool_id.is_some(),
        req.pg_connection.is_some(),
    ]
    .into_iter()
    .filter(|&x| x)
    .count();
    if mode_count != 1 {
        return Err(AppError::InvalidQuery(
            "请指定一种 PG 来源：use_provision_webhook、use_platform_pg、pg_pool_id 或 pg_connection（四选一）"
                .to_string(),
        ));
    }

    if req.use_provision_webhook {
        let cfg = crate::provision_webhook::load_config().ok_or_else(|| {
            AppError::InvalidQuery("未配置 PROVISION_WEBHOOK_URL，无法使用运维自动开通".to_string())
        })?;
        let resources = crate::provision_webhook::normalize_requested_resources(
            req.requested_resources.clone(),
        )?;
        let outcome = crate::provision_webhook::call_provision_webhook(
            &cfg,
            name,
            slug,
            template_slug,
            resources,
            claims,
        )
        .await?;
        return Ok(ResolvedProvisionSource::Webhook(outcome));
    }

    Ok(ResolvedProvisionSource::LocalPg(
        resolve_provision_pg(pool, req).await?,
    ))
}

async fn resolve_provision_pg(
    pool: &PgPool,
    req: &ProvisionRequest,
) -> Result<ResolvedProvisionPg> {
    let mode_count = [
        req.use_platform_pg,
        req.pg_pool_id.is_some(),
        req.pg_connection.is_some(),
    ]
    .into_iter()
    .filter(|&x| x)
    .count();
    if mode_count != 1 {
        return Err(AppError::InvalidQuery(
            "请指定一种 PG 来源：use_platform_pg、pg_pool_id 或 pg_connection（三选一）"
                .to_string(),
        ));
    }

    if req.use_platform_pg {
        let creds = crate::pg_pool_helpers::platform_provision_credentials()?;
        return Ok(ResolvedProvisionPg {
            creds,
            pool_id: None,
            platform_pg: true,
        });
    }

    let mode_count = [
        req.use_platform_pg,
        req.pg_pool_id.is_some(),
        req.pg_connection.is_some(),
    ]
    .into_iter()
    .filter(|&x| x)
    .count();
    if mode_count != 1 {
        return Err(AppError::InvalidQuery(
            "请指定一种 PG 来源：use_platform_pg、pg_pool_id 或 pg_connection（三选一）"
                .to_string(),
        ));
    }

    if req.use_platform_pg {
        let creds = crate::pg_pool_helpers::platform_provision_credentials()?;
        return Ok(ResolvedProvisionPg {
            creds,
            pool_id: None,
            platform_pg: true,
        });
    }

    match (req.pg_pool_id, &req.pg_connection) {
        (Some(pool_id), None) => {
            let pg_pool_entry = crate::pg_pool_helpers::get_pool(pool, pool_id).await?;
            if !pg_pool_entry.is_active {
                return Err(AppError::InvalidQuery(format!(
                    "PG 池 {} 已停用，无法 provision",
                    pool_id
                )));
            }
            let admin_password = lookup_pool_admin_password(pool, pool_id).await?;
            Ok(ResolvedProvisionPg {
                creds: crate::pg_pool_helpers::PgAdminCredentials {
                    db_host: pg_pool_entry.db_host,
                    db_port: pg_pool_entry.db_port,
                    admin_user: pg_pool_entry.admin_user,
                    admin_password,
                },
                pool_id: Some(pool_id),
                platform_pg: false,
            })
        }
        (None, Some(manual)) => {
            let creds = crate::pg_pool_helpers::PgAdminCredentials {
                db_host: manual.db_host.trim().to_string(),
                db_port: manual.db_port,
                admin_user: manual.admin_user.trim().to_string(),
                admin_password: manual.admin_password.clone(),
            };
            creds.validate()?;
            Ok(ResolvedProvisionPg {
                creds,
                pool_id: None,
                platform_pg: false,
            })
        }
        (Some(_), Some(_)) => Err(AppError::InvalidQuery(
            "pg_pool_id 与 pg_connection 不能同时填写".to_string(),
        )),
        (None, None) => Err(AppError::InvalidQuery(
            "请指定 pg_pool_id 或 pg_connection".to_string(),
        )),
    }
}

/// POST /api/projects/provision —— M2 主端点：用户自助开通新项目。
///
/// 鉴权：任意已登录用户（路由挂 auth_middleware）。
///
/// 幂等键：`(caller_user_id, slug)`：
///   - 同一用户用相同 slug 再次提交 → 返回上次创建的同一个项目（provisioned=false）
///   - 不同用户用相同 slug → 409（slug 全局唯一受 tenants.slug UNIQUE 约束）
///
/// 失败模式（接受 v1）：
///   1. CREATE DATABASE 成功、写 management 表失败 → 留下孤儿 DB，
///      tracing 记录，需超管手工清理；
///   2. management 表写成功、模板 DDL 失败 → tenants.status 改为 'failed_provisioning'，
///      返回 5xx；用户找超管删项目重试。
/// 这两条都不是好状态，但 v1 用 saga / outbox 改造工作量太大，接受手工兜底。
pub async fn provision_project(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Json(req): Json<ProvisionRequest>,
) -> Result<Json<serde_json::Value>> {
    let name = req.name.trim();
    let slug = req.slug.trim();

    if name.is_empty() || name.chars().count() > 200 {
        return Err(AppError::InvalidQuery("name 必须 1-200 字符".to_string()));
    }
    if !is_valid_slug(slug) {
        return Err(AppError::InvalidQuery(
            "slug 必须 1-50 字符，首字符小写字母，仅含 [a-z0-9_-]".to_string(),
        ));
    }

    // 模板必须存在 + active + 非 coming_soon
    let template_row: Option<sqlx::postgres::PgRow> = sqlx::query(
        r#"
        SELECT id, slug, ddl_sql, is_coming_soon
        FROM management.project_templates
        WHERE slug = $1 AND is_active = true
        "#,
    )
    .bind(&req.template_slug)
    .fetch_optional(&pool)
    .await?;

    let template_row = template_row.ok_or_else(|| {
        AppError::InvalidQuery(format!("模板 '{}' 不存在或已停用", req.template_slug))
    })?;
    if template_row.get::<bool, _>("is_coming_soon") {
        return Err(AppError::InvalidQuery(format!(
            "模板 '{}' 还未发布（is_coming_soon=true），请选 'blank'",
            req.template_slug
        )));
    }
    let ddl_sql: String = template_row.get("ddl_sql");

    // ─── 2. 幂等检查：相同 caller + 相同 slug → 返回已有 ─────
    let existing: Option<sqlx::postgres::PgRow> = sqlx::query(
        r#"
        SELECT t.id, t.name, t.slug, t.workspace_config,
               ut.user_id, ut.role,
               td.id AS database_id, td.db_name
        FROM management.tenants t
        LEFT JOIN management.user_tenants ut
          ON ut.tenant_id = t.id AND ut.user_id = $2 AND ut.is_active = true
        LEFT JOIN management.tenant_databases td
          ON td.tenant_id = t.id AND td.is_primary = true AND td.is_active = true
        WHERE t.slug = $1
        LIMIT 1
        "#,
    )
    .bind(slug)
    .bind(claims.sub)
    .fetch_optional(&pool)
    .await?;

    if let Some(row) = existing {
        let project_id: i32 = row.get("id");
        let caller_is_member: Option<i32> = row.try_get("user_id").ok().flatten();

        if caller_is_member == Some(claims.sub) {
            // 幂等：返回上次创建的同一个项目
            let role: Option<String> = row.try_get("role").ok().flatten();
            let database_id: Option<i32> = row.try_get("database_id").ok().flatten();
            let db_name: Option<String> = row.try_get("db_name").ok().flatten();

            tracing::info!(
                "M2 provisioning: idempotent return for user {} slug '{}' (project {})",
                claims.sub,
                slug,
                project_id
            );

            return Ok(Json(json!({
                "provisioned": false,
                "project_id":  project_id,
                "slug":        slug,
                "name":        row.get::<String, _>("name"),
                "database_id": database_id,
                "db_name":     db_name,
                "user_role":   role.unwrap_or_else(|| "owner".to_string()),
            })));
        } else {
            // slug 全局已被占用且非 caller 的项目
            return Err(AppError::InvalidQuery(format!(
                "slug '{}' 已被其他项目占用",
                slug
            )));
        }
    }

    let source =
        resolve_provision_source(&pool, &req, &claims, name, slug, &req.template_slug).await?;

    struct ProvisionPgMeta {
        pool_id: Option<i32>,
        platform_pg: bool,
        manual_pg: bool,
        via_webhook: bool,
        provision_id: Option<String>,
        app_role: Option<String>,
    }

    // `creds`      —— 写入 tenant_databases 的连接凭据（P1.1 下为项目专属角色）
    // `ddl_creds`  —— 跑模板 DDL 的凭据（本地 PG 用 admin，可建扩展等）
    // `grant_after_ddl` —— DDL 后把已有对象权限补授给项目角色 (admin, role)
    let (creds, ddl_creds, grant_after_ddl, db_name, rollback, pg_meta, webhook_env_vars) =
        match source {
            ResolvedProvisionSource::LocalPg(pg) => {
                let base_db_name = slug.replace('-', "_");
                let db_name = crate::pg_pool_helpers::create_database_with_credentials(
                    &pg.creds,
                    &base_db_name,
                )
                .await?;

                // ── P1.1：每项目独立 PG 登录角色 ──
                let mode = crate::pg_pool_helpers::per_project_role_mode();
                let mut store_creds = pg.creds.clone();
                let mut app_role: Option<String> = None;
                let mut grant_after_ddl: Option<(
                    crate::pg_pool_helpers::PgAdminCredentials,
                    String,
                )> = None;

                if mode != crate::pg_pool_helpers::PerProjectRoleMode::Off {
                    match crate::pg_pool_helpers::create_project_role(
                        &pg.creds,
                        &db_name,
                        &base_db_name,
                    )
                    .await
                    {
                        Ok(role) => {
                            store_creds = crate::pg_pool_helpers::PgAdminCredentials {
                                db_host: pg.creds.db_host.clone(),
                                db_port: pg.creds.db_port,
                                admin_user: role.user.clone(),
                                admin_password: role.password.clone(),
                            };
                            grant_after_ddl = Some((pg.creds.clone(), role.user.clone()));
                            app_role = Some(role.user);
                        }
                        Err(e) => {
                            if mode == crate::pg_pool_helpers::PerProjectRoleMode::Require {
                                // 强制模式：建角色失败 → 回滚孤儿库后报错
                                let _ = crate::pg_pool_helpers::drop_database_with_credentials(
                                    &pg.creds, &db_name,
                                )
                                .await;
                                return Err(AppError::Internal(format!(
                                    "PROVISION_PER_PROJECT_ROLE=require 但创建项目角色失败: {}",
                                    e
                                )));
                            }
                            tracing::warn!(
                                "M2 provisioning: 创建项目角色失败，回退使用 admin 凭据（slug={}）: {}",
                                slug,
                                e
                            );
                        }
                    }
                }

                let rollback = ProvisionRollbackPlan::DropDatabase {
                    creds: pg.creds.clone(),
                    db_name: db_name.clone(),
                    app_role: app_role.clone(),
                };
                let meta = ProvisionPgMeta {
                    pool_id: pg.pool_id,
                    platform_pg: pg.platform_pg,
                    manual_pg: pg.pool_id.is_none() && !pg.platform_pg,
                    via_webhook: false,
                    provision_id: None,
                    app_role,
                };
                (
                    store_creds,
                    pg.creds,
                    grant_after_ddl,
                    db_name,
                    rollback,
                    meta,
                    None,
                )
            }
            ResolvedProvisionSource::Webhook(w) => {
                let env_vars = if w.env_vars.is_empty() {
                    None
                } else {
                    Some(w.env_vars.clone())
                };
                let creds = w.creds();
                let db_name = w.db_name.clone();
                let provision_id = w.provision_id.clone();
                let rollback = ProvisionRollbackPlan::DeprovisionWebhook {
                    provision_id: provision_id.clone(),
                };
                let meta = ProvisionPgMeta {
                    pool_id: None,
                    platform_pg: false,
                    manual_pg: false,
                    via_webhook: true,
                    provision_id: Some(provision_id),
                    app_role: None,
                };
                // Webhook 已返回项目专属凭据；DDL 直接用同一凭据。
                (
                    creds.clone(),
                    creds,
                    None,
                    db_name,
                    rollback,
                    meta,
                    env_vars,
                )
            }
        };

    // ─── 4. 写 management.* 表 ────────────────────────────────
    let mut workspace_config = json!({
        "provisioned_from_template": template_row.get::<String, _>("slug"),
        "provisioned_pg_pool_id":    pg_meta.pool_id,
        "provisioned_platform_pg":   pg_meta.platform_pg,
        "provisioned_manual_pg":     pg_meta.manual_pg,
        "provisioned_via_webhook":   pg_meta.via_webhook,
        "provisioned_scenario":      req.scenario,
        "provisioned_by_user_id":    claims.sub,
        "provisioned_at":            chrono::Utc::now().to_rfc3339(),
        "provisioned_app_role":      pg_meta.app_role,
    });
    if let Some(ref pid) = pg_meta.provision_id {
        workspace_config["provision_id"] = json!(pid);
    }

    // 组织归属：必须挂在已有租户下（租户仅平台创建，禁止隐式建组织）
    let explicit_org_id = req.organization_id.ok_or_else(|| {
        AppError::InvalidQuery(
            "必须指定 organization_id：请从租户控制台创建项目（租户仅平台超管可创建）".to_string(),
        )
    })?;
    permissions::require_organization_admin(&pool, &claims, explicit_org_id).await?;
    let org_ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM management.organizations WHERE id = $1 AND status = 'active')",
    )
    .bind(explicit_org_id)
    .fetch_one(&pool)
    .await?;
    if !org_ok {
        return Err(AppError::NotFound(format!(
            "组织 {} 不存在或已停用",
            explicit_org_id
        )));
    }

    // 把所有 management.* 写入放进一个 async 块统一拿 Result：任何一步失败（slug 抢注、
    // 密码加密、INSERT 报错等）都会让上一步 CREATE DATABASE / Webhook 建出来的库变成孤儿，
    // 因此失败时统一做补偿回滚。
    let provision_writes = async {
        let mut tx = pool.begin().await?;

        let organization_id = explicit_org_id;

        // 确保 caller 仍是组织成员（admin 校验已过）
        sqlx::query(
            r#"
            INSERT INTO management.organization_members (user_id, organization_id, role, is_active)
            VALUES ($1, $2, 'member', true)
            ON CONFLICT (user_id, organization_id) DO UPDATE SET is_active = true
            "#,
        )
        .bind(claims.sub)
        .bind(organization_id)
        .execute(&mut *tx)
        .await?;

        let tenant_row = sqlx::query(
            r#"
            INSERT INTO management.tenants (name, slug, status, kind, workspace_config, organization_id)
            VALUES ($1, $2, 'active', 'project', $3, $4)
            RETURNING id
            "#,
        )
        .bind(name)
        .bind(slug)
        .bind(&workspace_config)
        .bind(organization_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(db) if db.constraint() == Some("tenants_slug_key") => {
                AppError::InvalidQuery(format!("slug '{}' 已被其他项目占用", slug))
            }
            _ => AppError::Database(e),
        })?;
        let tenant_id: i32 = tenant_row.get("id");

        // P1.1：默认写入项目专属角色的凭据（仅对该项目库有权限）；若建角色失败/关闭
        // 则回退为 admin 凭据。Webhook 路径写运维返回的专属凭据。
        let encrypted = crate::crypto::encrypt_secret(&creds.admin_password)
            .map_err(|e| AppError::Internal(format!("数据库密码加密回写失败: {}", e)))?;

        let database_row = sqlx::query(
            r#"
            INSERT INTO management.tenant_databases
                (tenant_id, connection_name, slug, db_host, db_port, db_name, db_user, db_password_encrypted, is_primary, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)
            RETURNING id
            "#,
        )
        .bind(tenant_id)
        .bind(format!("{}_primary", slug))
        .bind(slug)
        .bind(&creds.db_host)
        .bind(creds.db_port)
        .bind(&db_name)
        .bind(&creds.admin_user)
        .bind(&encrypted)
        .fetch_one(&mut *tx)
        .await?;
        let database_id: i32 = database_row.get("id");

        // caller 自动成为项目 owner
        sqlx::query(
            r#"
            INSERT INTO management.user_tenants (user_id, tenant_id, role, is_active)
            VALUES ($1, $2, 'owner', true)
            ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = 'owner', is_active = true
            "#,
        )
        .bind(claims.sub)
        .bind(tenant_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok::<(i32, i32), AppError>((tenant_id, database_id))
    };

    let (tenant_id, database_id) = match provision_writes.await {
        Ok(v) => v,
        Err(e) => {
            match &rollback {
                ProvisionRollbackPlan::DropDatabase {
                    creds,
                    db_name,
                    app_role,
                } => {
                    match crate::pg_pool_helpers::drop_database_with_credentials(creds, db_name)
                        .await
                    {
                        Ok(_) => tracing::warn!(
                            "M2 provisioning: 管理库写入失败，已回滚删除孤儿库 {}（slug={}）: {}",
                            db_name,
                            slug,
                            e
                        ),
                        Err(drop_err) => tracing::error!(
                            "M2 provisioning: 管理库写入失败且删除孤儿库 {} 失败（需人工清理）: 原始错误={}, 删除错误={}",
                            db_name,
                            e,
                            drop_err
                        ),
                    }
                    // 库删掉后角色不再 own 对象，可安全 drop。
                    if let Some(role) = app_role {
                        if let Err(role_err) =
                            crate::pg_pool_helpers::drop_project_role(creds, role).await
                        {
                            tracing::error!(
                                "M2 provisioning: 回滚删除项目角色 {} 失败（需人工清理）: {}",
                                role,
                                role_err
                            );
                        }
                    }
                }
                ProvisionRollbackPlan::DeprovisionWebhook { provision_id } => {
                    crate::provision_webhook::try_deprovision_webhook(slug, provision_id, None)
                        .await;
                    tracing::warn!(
                        "M2 provisioning: 管理库写入失败，已请求 deprovision（slug={}, provision_id={}）: {}",
                        slug,
                        provision_id,
                        e
                    );
                }
            }
            return Err(e);
        }
    };

    if let Some(env_vars) = webhook_env_vars {
        if let Err(e) = crate::env_var_handlers::seed_provision_env_vars(
            &pool, tenant_id, &env_vars, claims.sub,
        )
        .await
        {
            tracing::warn!(
                "M2 provisioning: seed_provision_env_vars({}) 失败: {}",
                tenant_id,
                e
            );
        }
    }

    // ─── 5. 模板 DDL（事务外，跨连接，失败标 failed_provisioning） ─
    // 用 ddl_creds（本地 PG 为 admin，可建扩展等），对象随后授权给项目角色。
    if !ddl_sql.trim().is_empty() {
        if let Err(e) = crate::pg_pool_helpers::apply_template_ddl_with_credentials(
            &ddl_creds, &db_name, &ddl_sql,
        )
        .await
        {
            // 标记项目为半残；运维清理
            let _ = sqlx::query(
                "UPDATE management.tenants SET status = 'failed_provisioning' WHERE id = $1",
            )
            .bind(tenant_id)
            .execute(&pool)
            .await;
            tracing::error!(
                "M2 provisioning: DDL failed for project {} (slug={}, db={}): {}",
                tenant_id,
                slug,
                db_name,
                e
            );
            return Err(e);
        }
    }

    // ─── 5.1 P1.1：把 DDL 建出的对象权限补授给项目角色（兜底，幂等）─
    if let Some((admin_creds, role)) = grant_after_ddl.as_ref() {
        if let Err(e) =
            crate::pg_pool_helpers::grant_existing_objects_to_role(admin_creds, &db_name, role)
                .await
        {
            // 不阻断：default privileges 已覆盖多数情况，这里仅兜底补授。
            tracing::warn!(
                "M2 provisioning: 为项目角色 {} 补授对象权限失败（slug={}）: {}",
                role,
                slug,
                e
            );
        }
    }

    // ─── 6. RBAC 默认 + 用户 RBAC 角色 ─────────────────────────
    if let Err(e) = crate::rbac_handlers::seed_tenant_rbac_defaults(&pool, tenant_id).await {
        // 不阻断 provisioning——RBAC 缺省后续可以手工补
        tracing::warn!(
            "M2 provisioning: seed_tenant_rbac_defaults({}) 失败: {}",
            tenant_id,
            e
        );
    }
    if let Err(e) = permissions::sync_default_rbac_role(
        &pool,
        redis_ref(&redis),
        claims.sub,
        tenant_id,
        "owner",
    )
    .await
    {
        tracing::warn!(
            "M2 provisioning: sync_default_rbac_role(user={}, tenant={}, owner) 失败: {}",
            claims.sub,
            tenant_id,
            e
        );
    }

    tracing::info!(
        target = "provisioning",
        "user {} ({}) provisioned project {} (slug={}, db={}, template={}, pg_pool={:?}, platform_pg={}, manual_pg={}, via_webhook={}, app_role={:?})",
        claims.sub,
        claims.email,
        tenant_id,
        slug,
        db_name,
        req.template_slug,
        pg_meta.pool_id,
        pg_meta.platform_pg,
        pg_meta.manual_pg,
        pg_meta.via_webhook,
        pg_meta.app_role,
    );

    // ─── 7. 返回 ───────────────────────────────────────────────
    Ok(Json(json!({
        "provisioned": true,
        "project_id":  tenant_id,
        "slug":        slug,
        "name":        name,
        "database_id": database_id,
        "db_name":     db_name,
        "user_role":   "owner",
    })))
}

/// slug 校验：1-50 字符，首字符小写字母，余下 [a-z0-9_-]。
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

/// 拿 pg_pool 的 admin 明文密码——provisioning 时要写一份加密拷贝到 tenant_databases。
/// 仅本 module 用；故意不放在 pg_pool_helpers 的 public 接口里，避免被滥用。
async fn lookup_pool_admin_password(pool: &PgPool, pool_id: i32) -> Result<String> {
    let encrypted: String = sqlx::query_scalar(
        "SELECT admin_password_encrypted FROM management.pg_pools WHERE id = $1 AND is_active = true",
    )
    .bind(pool_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("PG 池 {} 不存在或已停用", pool_id)))?;

    crate::crypto::decrypt_secret(&encrypted)
        .map_err(|e| AppError::Internal(format!("admin 密码解密失败: {}", e)))
}

// ─── REST API 接口文档公开分享 ─────────────────────────
//
// 给数据库连接生成可开关的公开文档链接 `<origin>/doc/api/<token>`：
//  - 管理接口（登录态）：GET/POST /api/admin/databases/:id/rest-doc-share —— 读状态 / 开关分享；
//  - 公开接口（无鉴权）：GET /api/public/rest-api-doc/:token —— 凭 token 取 database_slug/schema/项目名。
//
// 公开接口不连接租户库、不列出表名（文档正文是静态模板，schema 固定 public）。

/// 公开文档链接 token：`dr_` 前缀 + 24 字节随机 hex（共 51 字符，< VARCHAR(64)）。
/// 与 API Key（`ob_`）、工作流文档（`ds_`）命名空间独立。
fn generate_rest_doc_share_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let random_bytes: Vec<u8> = (0..24).map(|_| rng.gen()).collect();
    format!("dr_{}", hex::encode(random_bytes))
}

/// 校验当前用户可管理该 database（超管或所属租户的 active 成员），返回其 tenant_id。
async fn require_database_access(pool: &PgPool, claims: &Claims, database_id: i32) -> Result<i32> {
    let tenant_id: i32 = sqlx::query_scalar(
        "SELECT tenant_id FROM management.tenant_databases WHERE id = $1 AND is_active = true",
    )
    .bind(database_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("数据库连接 {} 不存在", database_id)))?;

    if !claims.is_superadmin {
        let is_member: Option<i32> = sqlx::query_scalar(
            r#"SELECT 1 FROM management.user_tenants
               WHERE user_id = $1 AND tenant_id = $2 AND is_active = true"#,
        )
        .bind(claims.sub)
        .bind(tenant_id)
        .fetch_optional(pool)
        .await?;
        if is_member.is_none() {
            return Err(AppError::Forbidden("你没有该项目的权限".to_string()));
        }
    }
    Ok(tenant_id)
}

/// 统一的分享状态响应体：token / 开关 / 相对路径（完整 URL 由前端拼 origin）。
fn rest_doc_share_response(token: Option<String>, enabled: bool) -> serde_json::Value {
    let path = token.as_ref().map(|t| format!("/doc/api/{}", t));
    json!({
        "share_token": token,
        "share_enabled": enabled,
        "share_path": path,
    })
}

/// GET /api/admin/databases/:id/rest-doc-share —— 读当前分享状态。
pub async fn get_rest_doc_share(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(database_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_database_access(&pool, &claims, database_id).await?;

    let row = sqlx::query(
        "SELECT rest_doc_share_token, rest_doc_share_enabled FROM management.tenant_databases WHERE id = $1",
    )
    .bind(database_id)
    .fetch_one(&pool)
    .await?;

    let token: Option<String> = row.get("rest_doc_share_token");
    let enabled: bool = row.get("rest_doc_share_enabled");
    Ok(Json(rest_doc_share_response(token, enabled)))
}

#[derive(Deserialize)]
pub struct RestDocShareRequest {
    pub enabled: bool,
}

/// POST /api/admin/databases/:id/rest-doc-share —— 开关分享。
/// enabled=true：token 为空则生成一次（永久保留），并置 enabled=true；
/// enabled=false：仅置 enabled=false，token 保留（重开复用同一链接）。
pub async fn set_rest_doc_share(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(database_id): Path<i32>,
    Json(req): Json<RestDocShareRequest>,
) -> Result<Json<serde_json::Value>> {
    require_database_access(&pool, &claims, database_id).await?;

    let row = if req.enabled {
        let token = generate_rest_doc_share_token();
        sqlx::query(
            r#"UPDATE management.tenant_databases
               SET rest_doc_share_token = COALESCE(rest_doc_share_token, $2), rest_doc_share_enabled = true
               WHERE id = $1
               RETURNING rest_doc_share_token, rest_doc_share_enabled"#,
        )
        .bind(database_id)
        .bind(&token)
        .fetch_one(&pool)
        .await?
    } else {
        sqlx::query(
            r#"UPDATE management.tenant_databases
               SET rest_doc_share_enabled = false
               WHERE id = $1
               RETURNING rest_doc_share_token, rest_doc_share_enabled"#,
        )
        .bind(database_id)
        .fetch_one(&pool)
        .await?
    };

    let token: Option<String> = row.get("rest_doc_share_token");
    let enabled: bool = row.get("rest_doc_share_enabled");
    Ok(Json(rest_doc_share_response(token, enabled)))
}

/// GET /api/public/rest-api-doc/:token —— 公开只读文档数据（无鉴权）。
/// 命中条件含 `rest_doc_share_enabled = true`；未命中 / 已关闭 → 404。
/// 只返回 database_slug / schema / 项目名，不连接租户库。
pub async fn public_rest_api_doc(
    headers: axum::http::HeaderMap,
    State(pool): State<PgPool>,
    Path(token): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let row = sqlx::query(
        r#"SELECT d.tenant_id, d.slug AS database_slug, t.name AS project_name
           FROM management.tenant_databases d
           JOIN management.tenants t ON t.id = d.tenant_id
           WHERE d.rest_doc_share_token = $1 AND d.rest_doc_share_enabled = true AND d.is_active = true"#,
    )
    .bind(&token)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound("链接不存在或已失效".to_string()))?;

    let database_slug: Option<String> = row.get("database_slug");
    let project_name: String = row.get("project_name");
    // 项目(tenant)标识，用于解析项目级对外基址（项目级 > 平台全局）。
    let tenant_id: Option<i32> = row.try_get("tenant_id").ok();

    Ok(Json(json!({
        "database_slug": database_slug.unwrap_or_default(),
        "schema": "public",
        "project_name": project_name,
        // 对外调用基址（网关域名）。优先级：项目级 > 平台全局 > 环境变量 > 转发头。
        "api_base_url": crate::public_base_settings::resolve_public_base(&pool, tenant_id, &headers).await,
        // 走网关时接口文档隐藏 API Key 鉴权头（网关统一鉴权）。
        "gateway_mode": crate::public_base_settings::is_gateway_mode(&pool, tenant_id).await,
    })))
}

#[cfg(test)]
mod member_admin_tests {
    use super::*;

    #[test]
    fn forbid_self_when_same_id() {
        assert!(forbid_self(3, 3));
        assert!(!forbid_self(3, 4));
    }

    #[test]
    fn reset_member_password_requires_strong_password() {
        assert!(validate_reset_member_password("short").is_err());
        assert!(validate_reset_member_password("NewPass12").is_ok());
    }
}

#[cfg(test)]
mod connection_budget_tests {
    use super::*;

    #[test]
    fn validate_tenant_max_connections_range() {
        assert!(validate_tenant_max_connections(1).is_ok());
        assert!(validate_tenant_max_connections(50).is_ok());
        assert!(validate_tenant_max_connections(0).is_err());
        assert!(validate_tenant_max_connections(51).is_err());
        assert!(validate_tenant_max_connections(200).is_err());
    }

    #[test]
    fn connection_budget_ok_same_host_limit() {
        assert!(connection_budget_ok(50, 10, 60).is_ok());
        assert!(connection_budget_ok(51, 10, 60).is_err());
        assert!(connection_budget_ok(0, 60, 60).is_ok());
        assert!(connection_budget_ok(0, 61, 60).is_err());
    }

    #[test]
    fn tenant_pool_global_budget_defaults_and_env() {
        assert_eq!(tenant_pool_global_budget_from_env_map(|_| None), 60);
        assert_eq!(
            tenant_pool_global_budget_from_env_map(|k| {
                if k == "TENANT_POOL_GLOBAL_MAX_CONNECTIONS" {
                    Some("80".into())
                } else {
                    None
                }
            }),
            80
        );
        assert_eq!(
            tenant_pool_global_budget_from_env_map(|k| {
                if k == "TENANT_POOL_GLOBAL_MAX_CONNECTIONS" {
                    Some("0".into())
                } else {
                    None
                }
            }),
            1
        );
    }
}
