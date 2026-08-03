use axum::{
    extract::{ConnectInfo, Extension, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use std::net::SocketAddr;
use validator::Validate;

use crate::auth::{generate_token, hash_password, jwt_expiration_secs, verify_password, Claims};
use crate::error::AppError;
use crate::models::{AuthResponse, LoginRequest, RegisterRequest, UserInfo};
use crate::redis_manager::RedisManager;

const LOGIN_RATE_LIMIT_MAX: u64 = 5;
const LOGIN_RATE_LIMIT_WINDOW: u64 = 60;

/// 把刚签发的 jti 写进 user_sessions，登记一条活跃会话
async fn record_session(
    pool: &PgPool,
    user_id: i32,
    jti: &str,
    user_agent: Option<&str>,
    ip: Option<&str>,
) -> Result<(), AppError> {
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(jwt_expiration_secs());

    // 把无法解析的 IP（如 "unknown"）当作 NULL，避免 INET 类型校验失败
    let ip_clean: Option<&str> = match ip {
        Some(s) if s.is_empty() || s == "unknown" => None,
        other => other,
    };

    sqlx::query(
        r#"
        INSERT INTO user_sessions (jti, user_id, expires_at, user_agent, ip)
        VALUES ($1::uuid, $2, $3, $4, $5::inet)
        "#,
    )
    .bind(jti)
    .bind(user_id)
    .bind(expires_at)
    .bind(user_agent)
    .bind(ip_clean)
    .execute(pool)
    .await
    .map_err(|e| AppError::Internal(format!("登记会话失败: {}", e)))?;

    Ok(())
}

#[derive(FromRow)]
struct UserRow {
    id: i32,
    username: String,
    email: String,
    password_hash: String,
    role: String,
    is_superadmin: bool,
    must_change_password: bool,
    created_at: chrono::NaiveDateTime,
}

#[derive(FromRow)]
struct UserPublicRow {
    id: i32,
    username: String,
    email: String,
    role: String,
    is_superadmin: bool,
    must_change_password: bool,
    created_at: chrono::NaiveDateTime,
}

/// 用户注册
pub async fn register(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    addr: Option<ConnectInfo<SocketAddr>>,
    Json(req): Json<RegisterRequest>,
) -> Result<(StatusCode, Json<AuthResponse>), AppError> {
    // 验证请求
    req.validate()
        .map_err(|e| AppError::InvalidQuery(format!("验证失败: {}", e)))?;

    // 检查邮箱是否已存在
    let existing_user: Option<(i32,)> = sqlx::query_as("SELECT id FROM users WHERE email = $1")
        .bind(&req.email)
        .fetch_optional(&pool)
        .await?;

    if existing_user.is_some() {
        return Err(AppError::InvalidQuery("邮箱已被注册".to_string()));
    }

    // 检查用户名是否已存在
    let existing_username: Option<(i32,)> =
        sqlx::query_as("SELECT id FROM users WHERE username = $1")
            .bind(&req.username)
            .fetch_optional(&pool)
            .await?;

    if existing_username.is_some() {
        return Err(AppError::InvalidQuery("用户名已被使用".to_string()));
    }

    // 哈希密码
    let password_hash = hash_password(&req.password)?;

    // 插入新用户
    let user: UserPublicRow = sqlx::query_as(
        r#"
        INSERT INTO users (username, email, password_hash, role)
        VALUES ($1, $2, $3, 'user')
        RETURNING id, username, email, role,
                  COALESCE(is_superadmin, false) AS is_superadmin,
                  COALESCE(must_change_password, false) AS must_change_password,
                  created_at
        "#,
    )
    .bind(&req.username)
    .bind(&req.email)
    .bind(&password_hash)
    .fetch_one(&pool)
    .await?;

    let (token, jti) = generate_token(user.id, &user.email, &user.role, user.is_superadmin)?;

    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    let ip = extract_client_ip(&headers, &addr);
    record_session(&pool, user.id, &jti, ua, Some(&ip)).await?;

    tracing::info!(
        target: "auth",
        user_id = user.id,
        email = %user.email,
        ip = %ip,
        "新用户注册成功"
    );

    let user_info = UserInfo {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        is_superadmin: user.is_superadmin,
        must_change_password: user.must_change_password,
        created_at: crate::models::naive_to_utc_string(user.created_at),
    };

    Ok((
        StatusCode::CREATED,
        Json(AuthResponse {
            token,
            user: user_info,
        }),
    ))
}

fn extract_client_ip(headers: &HeaderMap, addr: &Option<ConnectInfo<SocketAddr>>) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .map(String::from)
        })
        .or_else(|| addr.as_ref().map(|a| a.0.ip().to_string()))
        .unwrap_or_else(|| "unknown".to_string())
}

/// 用户登录
pub async fn login(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    addr: Option<ConnectInfo<SocketAddr>>,
    redis: Option<Extension<RedisManager>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    req.validate()
        .map_err(|e| AppError::InvalidQuery(format!("验证失败: {}", e)))?;

    let ip = extract_client_ip(&headers, &addr);

    if let Some(Extension(ref r)) = redis {
        let key = format!("login_rl:{}", ip);
        if let Ok(count) = r.incr_with_expire(&key, LOGIN_RATE_LIMIT_WINDOW).await {
            if count > LOGIN_RATE_LIMIT_MAX {
                tracing::warn!(
                    target: "auth",
                    email = %req.email,
                    ip = %ip,
                    count = count,
                    "登录频率超限，触发限流"
                );
                return Err(AppError::TooManyRequests(format!(
                    "登录尝试过于频繁，请 {} 秒后重试",
                    LOGIN_RATE_LIMIT_WINDOW
                )));
            }
        }
    }

    // 查询用户
    let user: UserRow = match sqlx::query_as(
        r#"
        SELECT id, username, email, password_hash, role,
               COALESCE(is_superadmin, false) AS is_superadmin,
               COALESCE(must_change_password, false) AS must_change_password,
               created_at
        FROM users
        WHERE email = $1
        "#,
    )
    .bind(&req.email)
    .fetch_optional(&pool)
    .await?
    {
        Some(u) => u,
        None => {
            tracing::warn!(
                target: "auth",
                email = %req.email,
                ip = %ip,
                "登录失败：邮箱不存在"
            );
            return Err(AppError::Unauthorized("邮箱或密码错误".to_string()));
        }
    };

    // 验证密码
    let password_valid = verify_password(&req.password, &user.password_hash)?;
    if !password_valid {
        tracing::warn!(
            target: "auth",
            user_id = user.id,
            email = %req.email,
            ip = %ip,
            "登录失败：密码错误"
        );
        return Err(AppError::Unauthorized("邮箱或密码错误".to_string()));
    }

    let (token, jti) = generate_token(user.id, &user.email, &user.role, user.is_superadmin)?;

    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    record_session(&pool, user.id, &jti, ua, Some(&ip)).await?;

    tracing::info!(
        target: "auth",
        user_id = user.id,
        email = %user.email,
        ip = %ip,
        "用户登录成功"
    );

    let user_info = UserInfo {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        is_superadmin: user.is_superadmin,
        must_change_password: user.must_change_password,
        created_at: crate::models::naive_to_utc_string(user.created_at),
    };

    Ok(Json(AuthResponse {
        token,
        user: user_info,
    }))
}

/// 获取当前用户信息
pub async fn get_me(
    Extension(claims): Extension<Claims>,
    State(pool): State<PgPool>,
) -> Result<Json<UserInfo>, AppError> {
    let user_id = claims.sub; // claims.sub 现在是 i32 类型

    let user: UserPublicRow = sqlx::query_as(
        r#"
        SELECT id, username, email, role,
               COALESCE(is_superadmin, false) AS is_superadmin,
               COALESCE(must_change_password, false) AS must_change_password,
               created_at
        FROM users
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("用户不存在".to_string()))?;

    Ok(Json(UserInfo {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        is_superadmin: user.is_superadmin,
        must_change_password: user.must_change_password,
        created_at: crate::models::naive_to_utc_string(user.created_at),
    }))
}

/// 刷新 token
///
/// 行为：
/// - 从 DB 重新读取 is_superadmin（防止权限降级后旧 token 仍生效）；
/// - 吊销旧 jti，签发新 jti，并登记到 user_sessions（旧 token 立即失效）。
pub async fn refresh_token(
    Extension(claims): Extension<Claims>,
    State(pool): State<PgPool>,
    headers: HeaderMap,
    addr: Option<ConnectInfo<SocketAddr>>,
) -> Result<Json<Value>, AppError> {
    let row: Option<(bool,)> =
        sqlx::query_as("SELECT COALESCE(is_superadmin, false) FROM users WHERE id = $1")
            .bind(claims.sub)
            .fetch_optional(&pool)
            .await?;

    let is_superadmin = row.map(|r| r.0).unwrap_or(false);

    // 吊销旧会话（旋转 jti）
    if !claims.jti.is_empty() {
        let _ = sqlx::query(
            "UPDATE user_sessions SET revoked = true, revoked_at = NOW(), revoke_reason = 'refresh' WHERE jti = $1::uuid",
        )
        .bind(&claims.jti)
        .execute(&pool)
        .await;
    }

    let (new_token, new_jti) =
        generate_token(claims.sub, &claims.email, &claims.role, is_superadmin)?;

    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    let ip = extract_client_ip(&headers, &addr);
    record_session(&pool, claims.sub, &new_jti, ua, Some(&ip)).await?;

    Ok(Json(json!({
        "token": new_token
    })))
}

/// 主动登出：吊销当前 jti
pub async fn logout(
    Extension(claims): Extension<Claims>,
    State(pool): State<PgPool>,
) -> Result<Json<Value>, AppError> {
    if claims.jti.is_empty() {
        return Ok(Json(json!({ "message": "已退出登录" })));
    }

    sqlx::query(
        "UPDATE user_sessions SET revoked = true, revoked_at = NOW(), revoke_reason = 'logout' WHERE jti = $1::uuid AND revoked = false",
    )
    .bind(&claims.jti)
    .execute(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("注销失败: {}", e)))?;

    tracing::info!(
        target: "auth",
        user_id = claims.sub,
        email = %claims.email,
        "用户登出成功"
    );

    Ok(Json(json!({ "message": "已退出登录" })))
}

/// 修改密码
#[derive(serde::Deserialize, validator::Validate)]
pub struct ChangePasswordRequest {
    #[validate(length(min = 1))]
    pub old_password: String,

    #[validate(length(min = 8))]
    pub new_password: String,
}

pub async fn change_password(
    Extension(claims): Extension<Claims>,
    State(pool): State<PgPool>,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<Value>, AppError> {
    req.validate()
        .map_err(|e| AppError::InvalidQuery(format!("验证失败: {}", e)))?;

    let user_id = claims.sub; // claims.sub 现在是 i32 类型

    // 获取用户当前密码（不使用 query! 宏以避免编译期连接数据库的依赖）
    let row: Option<(String,)> = sqlx::query_as("SELECT password_hash FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&pool)
        .await?;
    let password_hash = row
        .ok_or_else(|| AppError::Unauthorized("用户不存在".to_string()))?
        .0;

    // 验证旧密码
    let password_valid = verify_password(&req.old_password, &password_hash)?;
    if !password_valid {
        tracing::warn!(
            target: "auth",
            user_id,
            "修改密码失败：旧密码错误"
        );
        return Err(AppError::Unauthorized("旧密码错误".to_string()));
    }

    // 新密码不能与旧密码相同——否则内置默认密码“只能用一次”的约束形同虚设。
    if req.new_password == req.old_password {
        return Err(AppError::InvalidQuery(
            "新密码不能与旧密码相同".to_string(),
        ));
    }

    // 哈希新密码
    let new_password_hash = hash_password(&req.new_password)?;

    // 同步清除“需强制改密”标记并记录改密时间，之后 auth 网关不再拦截。
    sqlx::query(
        "UPDATE users SET password_hash = $1, must_change_password = false, password_changed_at = NOW() WHERE id = $2",
    )
    .bind(&new_password_hash)
    .bind(user_id)
    .execute(&pool)
    .await?;

    // 吊销该用户其它所有活跃会话（保留当前会话，让用户不至于立刻被踢出）
    let revoked_count = sqlx::query(
        r#"
        UPDATE user_sessions
        SET revoked = true, revoked_at = NOW(), revoke_reason = 'password_changed'
        WHERE user_id = $1
          AND revoked = false
          AND jti <> $2::uuid
        "#,
    )
    .bind(user_id)
    .bind(&claims.jti)
    .execute(&pool)
    .await
    .map(|r| r.rows_affected())
    .unwrap_or(0);

    tracing::info!(
        target: "auth",
        user_id,
        other_sessions_revoked = revoked_count,
        "用户修改密码成功"
    );

    Ok(Json(json!({
        "message": "密码修改成功",
        "other_sessions_revoked": revoked_count
    })))
}
