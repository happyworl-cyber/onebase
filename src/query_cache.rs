//! 查询结果缓存
//!
//! 将 Auto API 的 SELECT 查询结果缓存到 Redis。
//! 写操作（INSERT/UPDATE/DELETE）时自动失效相关表的缓存。
//!
//! 缓存 key: `qc:{database_id}:{schema}:{table}:{hash(query_params)}`
//! TTL 默认 60 秒。

use sha2::{Digest, Sha256};

use crate::redis_manager::RedisManager;

const QUERY_CACHE_TTL: u64 = 60;
const QC_PREFIX: &str = "qc";

pub struct QueryCache;

impl QueryCache {
    /// 为查询构造缓存 key
    /// fingerprint 包含排序后的查询参数、行条件、列过滤等
    fn cache_key(database_id: i32, schema: &str, table: &str, fingerprint: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(fingerprint.as_bytes());
        let hash = hex::encode(hasher.finalize());
        format!("{}:{}:{}:{}:{}", QC_PREFIX, database_id, schema, table, &hash[..16])
    }

    /// 表级 key 前缀（用于失效该表所有缓存）
    fn table_prefix(database_id: i32, schema: &str, table: &str) -> String {
        format!("{}:{}:{}:{}:*", QC_PREFIX, database_id, schema, table)
    }

    /// 构建查询指纹：将查询参数序列化为稳定的字符串
    ///
    /// 重要：fingerprint 必须包含 user_id —— 业务库启用 PostgreSQL RLS 时，
    /// 同一查询字符串在不同用户身份下的可见结果不同，缓存若不按 user 隔离会
    /// 把 user A 的结果泄漏给 user B。
    pub fn build_fingerprint(
        query_string: &str,
        row_conditions: &[String],
        allowed_columns: &Option<Vec<String>>,
        user_id: i32,
    ) -> String {
        // user_id 总是写入 fingerprint，0 代表匿名 / API Key 路径
        let mut parts = vec![format!("u:{}", user_id), query_string.to_string()];
        if !row_conditions.is_empty() {
            parts.push(format!("rc:{}", row_conditions.join("|")));
        }
        if let Some(cols) = allowed_columns {
            let mut sorted = cols.clone();
            sorted.sort();
            parts.push(format!("ac:{}", sorted.join(",")));
        }
        parts.join("||")
    }

    /// 从缓存获取查询结果
    pub async fn get(
        redis: &RedisManager,
        database_id: i32,
        schema: &str,
        table: &str,
        fingerprint: &str,
    ) -> Option<String> {
        let key = Self::cache_key(database_id, schema, table, fingerprint);
        match redis.get(&key).await {
            Ok(val) => val,
            Err(_) => None,
        }
    }

    /// 写入缓存
    pub async fn set(
        redis: &RedisManager,
        database_id: i32,
        schema: &str,
        table: &str,
        fingerprint: &str,
        data: &str,
    ) {
        let key = Self::cache_key(database_id, schema, table, fingerprint);
        let _ = redis.set_ex(&key, data, QUERY_CACHE_TTL).await;
    }

    /// 失效某张表的所有查询缓存（写操作后调用）
    pub async fn invalidate_table(
        redis: &RedisManager,
        database_id: i32,
        schema: &str,
        table: &str,
    ) {
        let pattern = Self::table_prefix(database_id, schema, table);
        let _ = redis.del_pattern(&pattern).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_key_deterministic() {
        let k1 = QueryCache::cache_key(1, "public", "posts", "fp1");
        let k2 = QueryCache::cache_key(1, "public", "posts", "fp1");
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_cache_key_different_fingerprints() {
        let k1 = QueryCache::cache_key(1, "public", "posts", "fp1");
        let k2 = QueryCache::cache_key(1, "public", "posts", "fp2");
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_cache_key_different_tables() {
        let k1 = QueryCache::cache_key(1, "public", "posts", "fp1");
        let k2 = QueryCache::cache_key(1, "public", "users", "fp1");
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_table_prefix_format() {
        let prefix = QueryCache::table_prefix(5, "myschema", "orders");
        assert_eq!(prefix, "qc:5:myschema:orders:*");
    }

    #[test]
    fn test_build_fingerprint_basic() {
        let fp = QueryCache::build_fingerprint("?limit=10&offset=0", &[], &None, 42);
        assert!(fp.starts_with("u:42||"));
        assert!(fp.contains("?limit=10&offset=0"));
    }

    #[test]
    fn test_build_fingerprint_user_isolation() {
        let fp_a = QueryCache::build_fingerprint("?limit=10", &[], &None, 1);
        let fp_b = QueryCache::build_fingerprint("?limit=10", &[], &None, 2);
        // 同样的查询、不同用户：fingerprint 必须不同（防 RLS 缓存串数据）
        assert_ne!(fp_a, fp_b);
    }

    #[test]
    fn test_build_fingerprint_with_conditions() {
        let fp = QueryCache::build_fingerprint(
            "?limit=10",
            &["author_id = 1".to_string()],
            &Some(vec!["title".to_string(), "id".to_string()]),
            7,
        );
        assert!(fp.starts_with("u:7||"));
        assert!(fp.contains("rc:author_id = 1"));
        assert!(fp.contains("ac:id,title")); // sorted
    }

    #[test]
    fn test_build_fingerprint_columns_sorted() {
        let fp1 = QueryCache::build_fingerprint(
            "",
            &[],
            &Some(vec!["z".to_string(), "a".to_string(), "m".to_string()]),
            0,
        );
        assert!(fp1.contains("ac:a,m,z"));
    }
}
