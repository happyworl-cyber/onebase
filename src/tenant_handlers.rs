use crate::auth::Claims;
use crate::error::Result;
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

/// GET /api/tenants/my-connections - 获取当前用户可访问的所有连接
pub async fn get_my_connections(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<ConnectionsQuery>,
) -> Result<Json<Vec<UserConnection>>> {
    let user_id = claims.sub;
    
    // 检查用户是否是超级管理员
    let is_superadmin = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(is_superadmin, false) FROM users WHERE id = $1"
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
                    td.connection_name,
                    td.db_host,
                    td.db_port,
                    td.db_name,
                    td.is_primary,
                    'superadmin' AS user_role
                FROM management.tenants t
                CROSS JOIN users u
                JOIN management.tenant_databases td ON td.tenant_id = t.id AND td.is_active = true
                WHERE u.id = $1 AND t.status = 'active' AND t.id = $2
                ORDER BY t.name, td.is_primary DESC, td.connection_name
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
                    td.connection_name,
                    td.db_host,
                    td.db_port,
                    td.db_name,
                    td.is_primary,
                    'superadmin' AS user_role
                FROM management.tenants t
                CROSS JOIN users u
                JOIN management.tenant_databases td ON td.tenant_id = t.id AND td.is_active = true
                WHERE u.id = $1 AND t.status = 'active'
                ORDER BY t.name, td.is_primary DESC, td.connection_name
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
                    user_id,
                    username,
                    tenant_id,
                    tenant_name,
                    database_id,
                    connection_name,
                    db_host,
                    db_port,
                    db_name,
                    is_primary,
                    user_role
                FROM management.v_user_connections
                WHERE user_id = $1 AND tenant_id = $2
                ORDER BY tenant_name, is_primary DESC, connection_name
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
                    user_id,
                    username,
                    tenant_id,
                    tenant_name,
                    database_id,
                    connection_name,
                    db_host,
                    db_port,
                    db_name,
                    is_primary,
                    user_role
                FROM management.v_user_connections
                WHERE user_id = $1
                ORDER BY tenant_name, is_primary DESC, connection_name
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

    // 加密密码
    let encrypted_password = encrypt_password(&req.db_password);

    // 插入数据库连接配置
    let db_connection = sqlx::query_as::<_, TenantDatabase>(
        r#"
        INSERT INTO management.tenant_databases 
        (tenant_id, connection_name, db_host, db_port, db_name, db_user, 
         db_password_encrypted, is_primary, max_connections, connection_timeout)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, tenant_id, connection_name, db_host, db_port, db_name, 
                  db_user, db_password_encrypted, is_primary, is_active, 
                  max_connections, connection_timeout
        "#,
    )
    .bind(req.tenant_id)
    .bind(&req.connection_name)
    .bind(&req.db_host)
    .bind(req.db_port)
    .bind(&req.db_name)
    .bind(&req.db_user)
    .bind(&encrypted_password)
    .bind(req.is_primary)
    .bind(req.max_connections.unwrap_or(10))
    .bind(req.connection_timeout.unwrap_or(30))
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
        max_connections: row.get::<Option<i32>, _>("max_connections").unwrap_or(10) as u32,
        connection_timeout: row
            .get::<Option<i32>, _>("connection_timeout")
            .unwrap_or(30) as u64,
    };

    // 创建或获取连接池
    let _pool = POOL_MANAGER.get_or_create_pool(config).await?;

    tracing::info!(
        "用户 {} 切换到数据库连接 {}",
        user_id,
        req.database_id
    );

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
    // 这里可以添加管理员权限检查
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
    
    // 验证超管权限
    let is_superadmin = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(is_superadmin, false) FROM users WHERE id = $1"
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

/// POST /api/admin/tenants - 创建新租户（超管专用）
pub async fn create_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let user_id = claims.sub;
    
    // 验证超管权限
    let is_superadmin = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(is_superadmin, false) FROM users WHERE id = $1"
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
    
    let name = req["name"].as_str().ok_or_else(|| {
        crate::error::AppError::InvalidQuery("缺少租户名称".to_string())
    })?;
    
    let slug = req["slug"].as_str().ok_or_else(|| {
        crate::error::AppError::InvalidQuery("缺少租户标识".to_string())
    })?;
    
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
                "数据库名称只能包含字母、数字和下划线，且不能以数字开头（最长 63 字符）".to_string()
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
            .map_err(|e| crate::error::AppError::Internal(
                format!("无法连接到数据库服务器: {}", e)
            ))?;
        
        // 检查数据库是否已存在
        let db_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)"
        )
        .bind(&db_name)
        .fetch_one(&temp_pool)
        .await?;
        
        if db_exists {
            return Err(crate::error::AppError::InvalidQuery(
                format!("数据库 {} 已存在", db_name)
            ));
        }
        
        // 创建新数据库
        // 使用 template0 避免 "template1 is being accessed by other users" 错误
        let create_db_sql = format!("CREATE DATABASE \"{}\" TEMPLATE template0", db_name);
        sqlx::query(&create_db_sql)
            .execute(&temp_pool)
            .await
            .map_err(|e| crate::error::AppError::Internal(
                format!("创建数据库失败: {}", e)
            ))?;
        
        tracing::info!("创建了新数据库: {}:{}/{}", db_host, db_port, db_name);
    }
    
    // 创建租户记录
    let tenant = sqlx::query(
        r#"
        INSERT INTO management.tenants (name, slug, contact_email, status)
        VALUES ($1, $2, $3, 'active')
        RETURNING id, name, slug, status, contact_email, created_at::TEXT as created_at
        "#,
    )
    .bind(name)
    .bind(slug)
    .bind(contact_email)
    .fetch_one(&pool)
    .await?;
    
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
            (tenant_id, connection_name, db_host, db_port, db_name, db_user, db_password_encrypted, is_primary, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, true, true)
            RETURNING id
            "#,
        )
        .bind(tenant_id)
        .bind(format!("{}_primary", slug))
        .bind(db_host)
        .bind(db_port)
        .bind(&db_name)
        .bind(db_user)
        .bind(encrypted_password)
        .fetch_one(&pool)
        .await?;
        
        database_id = Some(db_row.get::<i32, _>("id"));
        tracing::info!("为租户 {} 创建了数据库连接 (id={}): {}:{}/{}", tenant_id, database_id.unwrap(), db_host, db_port, db_name);
    }
    
    tracing::info!("超管 {} 创建了新租户: {}", user_id, name);
    
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
    Path(tenant_id): Path<i32>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let user_id = claims.sub;

    // 验证超管权限
    let is_superadmin = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(is_superadmin, false) FROM users WHERE id = $1"
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

    // 校验租户存在
    let exists: Option<(i32,)> = sqlx::query_as(
        "SELECT id FROM management.tenants WHERE id = $1"
    )
    .bind(tenant_id)
    .fetch_optional(&pool)
    .await?;

    if exists.is_none() {
        return Err(crate::error::AppError::NotFound(
            format!("租户 {} 不存在", tenant_id)
        ));
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
    let new_db_port = req.get("db_port").and_then(|v| v.as_i64()).map(|v| v as i32);
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
        user_id, tenant_id, affected_db_id
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
async fn ensure_superadmin(pool: &PgPool, user_id: i32) -> Result<()> {
    if permissions::is_platform_superadmin(pool, user_id).await {
        Ok(())
    } else {
        Err(crate::error::AppError::Unauthorized(
            "需要超级管理员权限".to_string(),
        ))
    }
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
        crate::error::AppError::InvalidQuery(
            "该租户尚未配置主数据库连接，无法管理副本".to_string(),
        )
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
        .ok_or_else(|| {
            crate::error::AppError::InvalidQuery("缺少 connection_name".to_string())
        })?;

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
        .unwrap_or(10);
    let connection_timeout = req
        .get("connection_timeout")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(30);

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
        } else if connection_changed
            || new_is_active == Some(true)
            || new_weight.is_some()
        {
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
                        max_connections: 10,
                        connection_timeout: 30,
                    };
                    let w: i32 = row.get("weight");
                    if let Err(e) =
                        POOL_MANAGER.upsert_replica(primary_id, replica_id, w, cfg).await
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
            last_replay_ts: row.try_get::<Option<String>, _>("last_replay_ts").unwrap_or(None),
            server_version: row.try_get::<Option<String>, _>("srv_version").unwrap_or(None),
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
    Path(tenant_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    let user_id = claims.sub;
    
    // 验证超管权限
    let is_superadmin = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(is_superadmin, false) FROM users WHERE id = $1"
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
    
    // 删除租户（会级联删除 tenant_databases, tenant_schemas, user_tenants）
    let result = sqlx::query(
        "DELETE FROM management.tenants WHERE id = $1 RETURNING name"
    )
    .bind(tenant_id)
    .fetch_optional(&pool)
    .await?;
    
    match result {
        Some(row) => {
            let name: String = row.get("name");
            tracing::info!("超管 {} 删除了租户: {} (id={})", user_id, name, tenant_id);
            Ok(Json(json!({
                "success": true,
                "message": format!("租户 {} 已删除", name)
            })))
        }
        None => {
            Err(crate::error::AppError::NotFound(
                format!("租户 {} 不存在", tenant_id)
            ))
        }
    }
}

/// GET /api/admin/users - 获取所有用户（超管专用）
pub async fn list_all_users(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<serde_json::Value>>> {
    let user_id = claims.sub;
    
    // 验证超管权限
    let is_superadmin = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(is_superadmin, false) FROM users WHERE id = $1"
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

    let tenant_id = req["tenant_id"].as_i64().ok_or_else(|| {
        crate::error::AppError::InvalidQuery("缺少租户ID".to_string())
    })? as i32;

    let role = req["role"].as_str().unwrap_or("member");

    let valid_roles = ["owner", "admin", "member", "viewer"];
    if !valid_roles.contains(&role) {
        return Err(crate::error::AppError::InvalidQuery(
            format!("Invalid role: {}. Must be one of: owner, admin, member, viewer", role),
        ));
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
    permissions::sync_default_rbac_role(
        &pool,
        redis_ref(&redis),
        target_user_id,
        tenant_id,
        role,
    )
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

