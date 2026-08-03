//! RBAC 权限缓存
//!
//! 将用户权限查询结果缓存到 Redis，减少频繁的数据库权限查询。
//! 缓存 key: `perm:{tenant_id}:{user_id}:{resource}:{action}`
//! TTL 默认 300 秒（5 分钟）。
//! 当角色/权限变更时，按 pattern 失效。

use crate::rbac_models::Permission;
use crate::redis_manager::RedisManager;

const PERM_CACHE_TTL: u64 = 300;
const PERM_KEY_PREFIX: &str = "perm";

pub struct PermissionCache;

impl PermissionCache {
    fn cache_key(tenant_id: i32, user_id: i32, resource: &str, action: &str) -> String {
        format!(
            "{}:{}:{}:{}:{}",
            PERM_KEY_PREFIX, tenant_id, user_id, resource, action
        )
    }

    /// 从缓存获取权限列表
    pub async fn get(
        redis: &RedisManager,
        tenant_id: i32,
        user_id: i32,
        resource: &str,
        action: &str,
    ) -> Option<Vec<Permission>> {
        let key = Self::cache_key(tenant_id, user_id, resource, action);
        match redis.get(&key).await {
            Ok(Some(data)) => {
                tracing::debug!(target: "perm_cache", key = %key, "权限缓存命中");
                serde_json::from_str(&data).ok()
            }
            _ => {
                tracing::debug!(target: "perm_cache", key = %key, "权限缓存未命中");
                None
            }
        }
    }

    /// 写入缓存
    pub async fn set(
        redis: &RedisManager,
        tenant_id: i32,
        user_id: i32,
        resource: &str,
        action: &str,
        permissions: &[Permission],
    ) {
        let key = Self::cache_key(tenant_id, user_id, resource, action);
        if let Ok(data) = serde_json::to_string(permissions) {
            let _ = redis.set_ex(&key, &data, PERM_CACHE_TTL).await;
            tracing::debug!(target: "perm_cache", key = %key, ttl = PERM_CACHE_TTL, "权限缓存写入");
        }
    }

    /// 失效某用户在某租户下的所有权限缓存
    pub async fn invalidate_user(redis: &RedisManager, tenant_id: i32, user_id: i32) {
        let pattern = format!("{}:{}:{}:*", PERM_KEY_PREFIX, tenant_id, user_id);
        let _ = redis.del_pattern(&pattern).await;
        tracing::debug!(
            target: "perm_cache",
            tenant_id = tenant_id,
            user_id = user_id,
            "权限缓存失效（按用户）"
        );
    }

    /// 失效某租户下所有用户的权限缓存（角色/权限定义变更时使用）
    pub async fn invalidate_tenant(redis: &RedisManager, tenant_id: i32) {
        let pattern = format!("{}:{}:*", PERM_KEY_PREFIX, tenant_id);
        let _ = redis.del_pattern(&pattern).await;
        tracing::debug!(
            target: "perm_cache",
            tenant_id = tenant_id,
            "权限缓存失效（按租户）"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_key_format() {
        let key = PermissionCache::cache_key(1, 42, "public.posts", "SELECT");
        assert_eq!(key, "perm:1:42:public.posts:SELECT");
    }

    #[test]
    fn test_cache_key_different_params() {
        let k1 = PermissionCache::cache_key(1, 1, "a.b", "SELECT");
        let k2 = PermissionCache::cache_key(1, 1, "a.b", "INSERT");
        let k3 = PermissionCache::cache_key(2, 1, "a.b", "SELECT");
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
    }
}
