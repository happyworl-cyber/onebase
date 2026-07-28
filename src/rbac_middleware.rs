//! RBAC 校验中间件
//!
//! 在 Auto API 请求链路中拦截请求，查询用户权限，
//! 将 PermissionResult 注入请求扩展供后续 handler 使用。

use axum::{
    extract::{Request, State},
    http::{HeaderMap, Method},
    middleware::Next,
    response::Response,
};
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::AppError;
use crate::permission_cache::PermissionCache;
use crate::rbac_handlers::{merge_permissions, query_user_permissions};
use crate::rbac_models::{is_safe_identifier, PermissionResult};
use crate::redis_manager::RedisManager;

/// 从 URI 路径 + 请求头中提取 Auto API 的 (database_id, schema, table)。
///
/// 支持两种 path 形态：
///
/// 1. 标准三段：`/api/v1/{database_id}/{schema}/{table}[/{id}]`
///    —— schema 在 path 第 4 段
/// 2. PostgREST 兼容两段：`/api/v1/{database_id}/{table}`
///    —— schema 必须来自 `Content-Profile`（写）或 `Accept-Profile`（读）请求头；
///       非法 / 缺失则回落到 `public`。与
///       [`crate::postgrest_compat::resolve_schema`] 行为完全对齐
///
/// **安全不变式**：无论哪种形态都会走完整 RBAC 检查链；不能因为业务方用了两段路径
/// 就静默放过权限校验（这是当初 layer-rewrite 方案被废弃的核心原因之一）。
fn extract_auto_api_parts(
    path: &str,
    method: &Method,
    headers: &HeaderMap,
) -> Option<(i32, String, String)> {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if !(segments.len() >= 4 && segments[0] == "api" && segments[1] == "v1") {
        return None;
    }

    let db_id = segments[2].parse::<i32>().ok()?;

    // 三段：path 里直接拿 schema/table，覆盖 `/:schema/:table[/:id]`
    if segments.len() >= 5 {
        // 防御性：跳过 `/api/v1/:db/rpc/:fn_name`（RPC 路由自己有鉴权）
        if segments[3] == "rpc" {
            return None;
        }
        let schema = segments[3].to_string();
        let table = segments[4].to_string();
        return Some((db_id, schema, table));
    }

    // 两段：`/api/v1/:db/:table` —— PostgREST 兼容形态
    // 第 3 段如果是 "rpc" 不该走这里（RPC 是 /api/v1/:db/rpc/:fn_name 三段），但安全起见挡一下
    if segments[3] == "rpc" {
        return None;
    }
    let table = segments[3].to_string();
    if table.is_empty() {
        return None;
    }

    let primary_header = if matches!(*method, Method::POST | Method::PATCH | Method::PUT) {
        "content-profile"
    } else {
        "accept-profile"
    };
    let schema = headers
        .get(primary_header)
        .or_else(|| headers.get("accept-profile"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && is_safe_identifier(s))
        .unwrap_or_else(|| "public".to_string());
    Some((db_id, schema, table))
}

/// HTTP Method 到 RBAC action 的映射
fn method_to_action(method: &Method) -> &'static str {
    match *method {
        Method::GET => "SELECT",
        Method::POST => "INSERT",
        Method::PATCH | Method::PUT => "UPDATE",
        Method::DELETE => "DELETE",
        _ => "SELECT",
    }
}

/// RBAC 权限校验中间件
///
/// 1. 提取 Claims (user_id) — 如果没有则拒绝
/// 2. 解析路径得到 database_id / schema / table
/// 3. 查询 database_id 对应的 tenant_id
/// 4. 查询用户在该 tenant 下对该资源的权限
/// 5. 合并权限并注入 PermissionResult
pub async fn rbac_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let headers = req.headers().clone();

    // 只处理 Auto API 路径
    let (database_id, schema, table) = match extract_auto_api_parts(&path, &method, &headers) {
        Some(parts) => parts,
        None => {
            return Ok(next.run(req).await);
        }
    };

    let action = method_to_action(&method);
    let resource = format!("{}.{}", schema, table);

    // 尝试获取 JWT Claims
    let claims_opt = req.extensions().get::<Claims>().cloned();

    match claims_opt {
        Some(claims) => {
            let user_id = claims.sub;

            // 检查是否为超管
            let sa_row = sqlx::query(
                "SELECT COALESCE(is_superadmin, false) AS sa FROM users WHERE id = $1",
            )
            .bind(user_id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("查询用户失败: {}", e)))?;

            if sa_row.map(|r| r.get::<bool, _>("sa")).unwrap_or(false) {
                req.extensions_mut().insert(PermissionResult::superadmin());
                return Ok(next.run(req).await);
            }

            // 查询 database_id → tenant_id
            let tenant_row = sqlx::query(
                "SELECT tenant_id FROM management.tenant_databases WHERE id = $1 AND is_active = true",
            )
            .bind(database_id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("查询租户失败: {}", e)))?;

            let tenant_id = match tenant_row {
                Some(r) => r.get::<i32, _>("tenant_id"),
                None => {
                    return Err(AppError::NotFound(format!(
                        "数据库连接 {} 不存在",
                        database_id
                    )));
                }
            };

            // 尝试从 Redis 缓存获取权限
            let redis_opt = req.extensions().get::<RedisManager>().cloned();

            let permissions = if let Some(ref redis) = redis_opt {
                match PermissionCache::get(redis, tenant_id, user_id, &resource, action).await {
                    Some(cached) => {
                        tracing::debug!("RBAC 权限命中缓存: user={} resource={}", user_id, resource);
                        cached
                    }
                    None => {
                        let perms = query_user_permissions(&pool, user_id, tenant_id, &resource, action).await?;
                        PermissionCache::set(redis, tenant_id, user_id, &resource, action, &perms).await;
                        perms
                    }
                }
            } else {
                query_user_permissions(&pool, user_id, tenant_id, &resource, action).await?
            };

            if permissions.is_empty() {
                return Err(AppError::Forbidden(format!(
                    "没有权限对 {} 执行 {} 操作",
                    resource, action
                )));
            }

            let result = merge_permissions(&permissions, user_id);
            req.extensions_mut().insert(result);
        }
        None => {
            // 没有 JWT → 必须是 API Key
            let api_key = req
                .headers()
                .get("Authorization")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .filter(|s| s.starts_with("cr_"))
                .ok_or_else(|| {
                    AppError::Unauthorized(
                        "请提供有效的 API Key 或 JWT Token".to_string(),
                    )
                })?;

            // 查询 API Key 记录（含 scope）
            let key_row = sqlx::query(
                r#"
                SELECT database_id, permissions
                FROM management.api_keys
                WHERE key_hash = encode(sha256($1::bytea), 'hex')
                  AND is_active = true
                  AND (expires_at IS NULL OR expires_at > NOW())
                "#,
            )
            .bind(api_key)
            .fetch_optional(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("校验 API Key 失败: {}", e)))?;

            let row = key_row.ok_or_else(|| {
                AppError::Unauthorized("API Key 无效或已过期".to_string())
            })?;

            let key_db_id: i32 = row.get("database_id");
            if key_db_id != database_id {
                return Err(AppError::Unauthorized(
                    "API Key 与数据库不匹配".to_string(),
                ));
            }

            // Also validate X-Database-Id header if present to prevent header spoofing
            if let Some(header_db_id) = req.headers()
                .get("X-Database-Id")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.parse::<i32>().ok())
            {
                if key_db_id != header_db_id {
                    return Err(AppError::Forbidden(
                        "API key does not have access to this database".to_string(),
                    ));
                }
            }

            let permissions: serde_json::Value = row.get("permissions");
            check_api_key_scope(&permissions, &resource, action, &schema)?;

            // 通过 scope 校验 → 注入"无 RBAC 行/列限制"的允许结果
            // （API Key 仅在 scope 层面控制；行/列限制需切换到 JWT + RBAC）
            req.extensions_mut().insert(PermissionResult {
                allowed: true,
                row_conditions: vec![],
                allowed_columns: None,
                is_superadmin: false,
            });
        }
    }

    Ok(next.run(req).await)
}

/// 校验 API Key 的 scope 是否覆盖目标 (resource, action)
///
/// permissions JSONB 支持新旧两种格式：
/// - 新格式（推荐）：
///   ```json
///   {
///     "allowed_resources": ["public.posts", "public.comments", "audit.*"],
///     "allowed_actions":   ["SELECT", "INSERT"]
///   }
///   ```
///   `*` 表示通配；`schema.*` 表示该 schema 下所有表。
/// - 旧格式（向后兼容）：
///   ```json
///   { "read": true, "write": true, "delete": true }
///   ```
///   `read=SELECT`，`write=INSERT|UPDATE`，`delete=DELETE`。
///   旧格式下 resource 视为通配（兼容历史行为），仅按 action 校验。
fn check_api_key_scope(
    permissions: &serde_json::Value,
    resource: &str,
    action: &str,
    schema: &str,
) -> Result<(), AppError> {
    // 新格式优先
    let new_format = permissions.get("allowed_actions").is_some()
        || permissions.get("allowed_resources").is_some();

    if new_format {
        let actions = permissions
            .get("allowed_actions")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_uppercase)).collect::<Vec<_>>())
            .unwrap_or_default();

        if !actions.is_empty()
            && !actions.iter().any(|a| a == "*" || a == action || a == "ALL")
        {
            return Err(AppError::Forbidden(format!(
                "API Key 不允许执行 {} 操作",
                action
            )));
        }

        let resources = permissions
            .get("allowed_resources")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect::<Vec<_>>())
            .unwrap_or_default();

        if !resources.is_empty() {
            let schema_wildcard = format!("{}.*", schema);
            let allowed = resources.iter().any(|r| {
                r == "*" || r == "*.*" || r == resource || r == &schema_wildcard
            });
            if !allowed {
                return Err(AppError::Forbidden(format!(
                    "API Key 不允许访问资源: {}",
                    resource
                )));
            }
        }
        return Ok(());
    }

    // 旧格式（仅按 action 类别校验）
    let allow_action = match action {
        "SELECT" => permissions.get("read").and_then(|v| v.as_bool()).unwrap_or(false),
        "INSERT" | "UPDATE" => {
            permissions.get("write").and_then(|v| v.as_bool()).unwrap_or(false)
        }
        "DELETE" => permissions.get("delete").and_then(|v| v.as_bool()).unwrap_or(false),
        _ => false,
    };
    if !allow_action {
        return Err(AppError::Forbidden(format!(
            "API Key 不允许执行 {} 操作",
            action
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};

    fn empty_headers() -> HeaderMap {
        HeaderMap::new()
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut hh = HeaderMap::new();
        for (k, v) in pairs {
            hh.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        hh
    }

    #[test]
    fn test_extract_auto_api_parts_valid() {
        let parts =
            extract_auto_api_parts("/api/v1/3/public/posts", &Method::GET, &empty_headers());
        assert!(parts.is_some());
        let (db_id, schema, table) = parts.unwrap();
        assert_eq!(db_id, 3);
        assert_eq!(schema, "public");
        assert_eq!(table, "posts");
    }

    #[test]
    fn test_extract_auto_api_parts_with_id() {
        let parts = extract_auto_api_parts(
            "/api/v1/10/myschema/users/42",
            &Method::GET,
            &empty_headers(),
        );
        assert!(parts.is_some());
        let (db_id, schema, table) = parts.unwrap();
        assert_eq!(db_id, 10);
        assert_eq!(schema, "myschema");
        assert_eq!(table, "users");
    }

    #[test]
    fn test_extract_auto_api_parts_non_auto_api() {
        assert!(extract_auto_api_parts("/api/schemas", &Method::GET, &empty_headers()).is_none());
        assert!(extract_auto_api_parts("/auth/login", &Method::GET, &empty_headers()).is_none());
        // 第三段不是 i32 → 不可解析
        assert!(extract_auto_api_parts(
            "/api/v1/abc/public/posts",
            &Method::GET,
            &empty_headers()
        )
        .is_none());
    }

    #[test]
    fn test_extract_auto_api_parts_too_short() {
        // 三段以内的不识别（必须至少有 db_id + table）
        assert!(extract_auto_api_parts("/api/v1/3", &Method::GET, &empty_headers()).is_none());
    }

    #[test]
    fn test_extract_auto_api_parts_pgrest_two_segments_with_accept_profile() {
        // 两段路径：schema 从 Accept-Profile 头取
        let parts = extract_auto_api_parts(
            "/api/v1/3/posts",
            &Method::GET,
            &headers(&[("accept-profile", "gamesq")]),
        );
        assert!(parts.is_some());
        let (db_id, schema, table) = parts.unwrap();
        assert_eq!(db_id, 3);
        assert_eq!(schema, "gamesq");
        assert_eq!(table, "posts");
    }

    #[test]
    fn test_extract_auto_api_parts_pgrest_post_uses_content_profile() {
        let parts = extract_auto_api_parts(
            "/api/v1/3/posts",
            &Method::POST,
            &headers(&[("content-profile", "gamesq"), ("accept-profile", "wrong")]),
        );
        let (_, schema, _) = parts.unwrap();
        assert_eq!(schema, "gamesq");
    }

    #[test]
    fn test_extract_auto_api_parts_pgrest_default_public_when_no_header() {
        let parts = extract_auto_api_parts("/api/v1/3/posts", &Method::GET, &empty_headers());
        let (_, schema, table) = parts.unwrap();
        assert_eq!(schema, "public");
        assert_eq!(table, "posts");
    }

    #[test]
    fn test_extract_auto_api_parts_skips_rpc_route() {
        // 三段：rpc 子路由不该走 Auto API RBAC（RPC 路由有自己的鉴权链）
        assert!(extract_auto_api_parts(
            "/api/v1/3/rpc/some_fn",
            &Method::POST,
            &empty_headers()
        )
        .is_none());
        // 两段：path 段第 4 个不会是 rpc（rpc 路由本身是三段），但防御性挡一下
    }

    #[test]
    fn test_extract_auto_api_parts_pgrest_unsafe_schema_falls_back() {
        let parts = extract_auto_api_parts(
            "/api/v1/3/posts",
            &Method::GET,
            &headers(&[("accept-profile", "g; DROP TABLE users")]),
        );
        let (_, schema, _) = parts.unwrap();
        assert_eq!(schema, "public");
    }

    #[test]
    fn test_method_to_action() {
        assert_eq!(method_to_action(&Method::GET), "SELECT");
        assert_eq!(method_to_action(&Method::POST), "INSERT");
        assert_eq!(method_to_action(&Method::PATCH), "UPDATE");
        assert_eq!(method_to_action(&Method::PUT), "UPDATE");
        assert_eq!(method_to_action(&Method::DELETE), "DELETE");
        assert_eq!(method_to_action(&Method::HEAD), "SELECT");
    }
}
