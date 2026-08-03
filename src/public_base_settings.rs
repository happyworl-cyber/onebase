//! 对外调用基址（网关域名）设置：平台全局 + 项目级，统一存 `management.public_base_settings`。
//!
//! 作用域：`tenant_id IS NULL` 为平台全局（超管配置）；`tenant_id = <项目id>` 为项目级
//! （项目 admin 配置）。「项目」= 一个 `management.tenants`（`projectId === tenants.id`）。
//!
//! 运行期解析优先级（先命中先用）：
//!   1. 项目级 `public_base_settings(tenant_id=N)`（最高）
//!   2. 平台全局 `public_base_settings(tenant_id IS NULL)`
//!   3. `PUBLIC_BASE_URL` 环境变量
//!   4. 反代转发头 `X-Forwarded-Host` / 原始 `Host` / 浏览器 origin
//!
//! 保存即时生效（超管改平台级、项目 admin 改本项目级），无需改代码/重启/重新构建前端。
//! DB 值按作用域分桶缓存（短 TTL），写操作主动失效对应桶。

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::{Extension, Json};
use dashmap::DashMap;
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::time::{Duration, Instant};

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permissions::{require_platform_superadmin, require_tenant_admin};

const CACHE_TTL: Duration = Duration::from_secs(10);
/// 平台全局作用域的缓存哨兵 key（tenant id 恒 > 0，用 0 不会冲突）。
const PLATFORM_KEY: i32 = 0;

/// 按作用域分桶缓存：key = tenant_id 或 PLATFORM_KEY；value = `(基址, 取值时间)`。
static CACHE: Lazy<DashMap<i32, (Option<String>, Instant)>> = Lazy::new(DashMap::new);

fn normalize(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// 规范化 + 协议校验；空串/None → None（清空，回落上层作用域）。
fn normalize_and_validate(raw: Option<String>) -> Result<Option<String>> {
    match raw {
        Some(s) => match normalize(&s) {
            Some(v) => {
                if !(v.starts_with("http://") || v.starts_with("https://")) {
                    return Err(AppError::InvalidQuery(
                        "对外基址必须以 http:// 或 https:// 开头".to_string(),
                    ));
                }
                Ok(Some(v))
            }
            None => Ok(None),
        },
        None => Ok(None),
    }
}

fn cache_key(tenant_id: Option<i32>) -> i32 {
    tenant_id.unwrap_or(PLATFORM_KEY)
}

/// 读取某作用域（`None`=平台全局 / `Some(id)`=项目）配置的对外基址（已规范化）。
pub async fn get_base_url(pool: &PgPool, tenant_id: Option<i32>) -> Option<String> {
    let key = cache_key(tenant_id);
    if let Some(entry) = CACHE.get(&key) {
        if entry.1.elapsed() < CACHE_TTL {
            return entry.0.clone();
        }
    }

    // Option<Option<String>>：外层=行是否存在，内层=列是否 NULL。
    let fetched: Option<Option<String>> = match tenant_id {
        Some(tid) => sqlx::query_scalar(
            "SELECT public_base_url FROM management.public_base_settings WHERE tenant_id = $1",
        )
        .bind(tid)
        .fetch_optional(pool)
        .await
        .ok(),
        None => sqlx::query_scalar(
            "SELECT public_base_url FROM management.public_base_settings WHERE tenant_id IS NULL",
        )
        .fetch_optional(pool)
        .await
        .ok(),
    };
    let value = fetched.flatten().and_then(|s| normalize(&s));

    CACHE.insert(key, (value.clone(), Instant::now()));
    value
}

fn invalidate(tenant_id: Option<i32>) {
    CACHE.remove(&cache_key(tenant_id));
}

/// 写入某作用域的对外基址（upsert）；`None`=平台全局。
async fn set_base_url(pool: &PgPool, tenant_id: Option<i32>, value: Option<String>) -> Result<()> {
    match tenant_id {
        Some(tid) => {
            sqlx::query(
                "INSERT INTO management.public_base_settings (tenant_id, public_base_url, updated_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (tenant_id) WHERE tenant_id IS NOT NULL
                 DO UPDATE SET public_base_url = EXCLUDED.public_base_url, updated_at = NOW()",
            )
            .bind(tid)
            .bind(&value)
            .execute(pool)
            .await?;
        }
        None => {
            // 平台全局行由迁移预置；正常 UPDATE 命中。若被清库删掉则补插。
            let affected = sqlx::query(
                "UPDATE management.public_base_settings SET public_base_url = $1, updated_at = NOW() WHERE tenant_id IS NULL",
            )
            .bind(&value)
            .execute(pool)
            .await?
            .rows_affected();
            if affected == 0 {
                sqlx::query(
                    "INSERT INTO management.public_base_settings (tenant_id, public_base_url) VALUES (NULL, $1)",
                )
                .bind(&value)
                .execute(pool)
                .await?;
            }
        }
    }
    invalidate(tenant_id);
    Ok(())
}

/// 解析最终对外调用基址：项目级 > 平台全局 > 环境变量 > 转发头 > 空串。
/// `tenant_id=None` 时跳过项目级。
pub async fn resolve_public_base(
    pool: &PgPool,
    tenant_id: Option<i32>,
    headers: &HeaderMap,
) -> String {
    if let Some(tid) = tenant_id {
        if let Some(v) = get_base_url(pool, Some(tid)).await {
            return v;
        }
    }
    if let Some(v) = get_base_url(pool, None).await {
        return v;
    }
    crate::public_base::resolve_public_base(headers)
}

/// 是否走网关：项目级或平台全局任一显式配置了对外基址（或 `PUBLIC_BASE_URL` 环境变量）。
pub async fn is_gateway_mode(pool: &PgPool, tenant_id: Option<i32>) -> bool {
    if let Some(tid) = tenant_id {
        if get_base_url(pool, Some(tid)).await.is_some() {
            return true;
        }
    }
    get_base_url(pool, None).await.is_some() || crate::public_base::configured_public_base().is_some()
}

#[derive(Deserialize)]
pub struct FrontendConfigQuery {
    /// 当前项目 id（tenant_id）；应用内页面传入以拿项目级基址，公开分享页由后端载荷注入不走这里。
    pub tenant_id: Option<i32>,
}

/// GET /api/public/frontend/config —— 运行期前端配置（无鉴权）。
///
/// 支持可选 `?tenant_id=` 拿项目级对外基址（项目级 > 平台全局 > 兜底）。
/// 取代构建期烤死的 `NEXT_PUBLIC_API_URL`，页面改域名后即时反映。
pub async fn public_frontend_config(
    headers: HeaderMap,
    Query(q): Query<FrontendConfigQuery>,
    State(pool): State<PgPool>,
) -> Json<Value> {
    Json(json!({
        "api_base_url": resolve_public_base(&pool, q.tenant_id, &headers).await,
        "gateway_mode": is_gateway_mode(&pool, q.tenant_id).await,
    }))
}

// ---------------------------------------------------------------------------
// 平台全局（超管）
// ---------------------------------------------------------------------------

/// GET /api/admin/platform-settings —— 超管读取平台全局对外基址（含实际生效值）。
pub async fn get_platform_settings(
    headers: HeaderMap,
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>> {
    require_platform_superadmin(&claims)?;
    let stored = get_base_url(&pool, None).await;
    let effective = resolve_public_base(&pool, None, &headers).await;
    Ok(Json(json!({
        "public_base_url": stored,
        "effective_base_url": effective,
        "env_public_base_url": crate::public_base::configured_public_base(),
    })))
}

#[derive(Deserialize)]
pub struct UpdateBody {
    /// 传字符串设置；传 `null` 或空串清空（回落上层）。
    #[serde(default)]
    pub public_base_url: Option<String>,
}

/// PUT /api/admin/platform-settings —— 超管保存平台全局对外基址。
pub async fn update_platform_settings(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Value>> {
    require_platform_superadmin(&claims)?;
    let normalized = normalize_and_validate(body.public_base_url)?;
    set_base_url(&pool, None, normalized.clone()).await?;
    Ok(Json(json!({ "public_base_url": normalized })))
}

// ---------------------------------------------------------------------------
// 项目级（项目 admin+）
// ---------------------------------------------------------------------------

/// GET /api/projects/:id/gateway-settings —— 项目 admin+ 读取本项目对外基址设置。
pub async fn get_project_gateway_settings(
    headers: HeaderMap,
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<Value>> {
    require_tenant_admin(&pool, &claims, project_id).await?;
    let stored = get_base_url(&pool, Some(project_id)).await;
    let effective = resolve_public_base(&pool, Some(project_id), &headers).await;
    let platform_default = get_base_url(&pool, None).await;
    Ok(Json(json!({
        // 本项目保存的值（NULL=未配置，回落平台/环境）。
        "public_base_url": stored,
        // 当前实际生效的对外基址（含平台/环境/转发头兜底）。
        "effective_base_url": effective,
        // 平台级默认值，供页面提示"留空将回落到它"。
        "platform_base_url": platform_default,
    })))
}

/// PUT /api/projects/:id/gateway-settings —— 项目 admin+ 保存本项目对外基址。
pub async fn update_project_gateway_settings(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Value>> {
    require_tenant_admin(&pool, &claims, project_id).await?;
    let normalized = normalize_and_validate(body.public_base_url)?;
    set_base_url(&pool, Some(project_id), normalized.clone()).await?;
    Ok(Json(json!({ "public_base_url": normalized })))
}
