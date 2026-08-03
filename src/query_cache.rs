//! 查询结果缓存
//!
//! 将 Auto API 的 SELECT 查询结果缓存到 Redis。
//! 写操作（INSERT/UPDATE/DELETE）时自动失效相关表的缓存。
//!
//! ## 失效策略：表级版本号（generation），而非 SCAN 删除
//!
//! 历史实现用 `SCAN MATCH qc:{db}:{schema}:{table}:* + DEL` 来失效一张表的缓存。
//! 致命问题：Redis 的 `SCAN MATCH` 是**全 keyspace 遍历**（MATCH 只在服务端过滤、不会
//! 跳过不匹配的 key），在 key 较多的（共享）实例上，每次写入都要 `keyspace/COUNT` 次往返，
//! 几千次 RTT 累计逼近 ~10s，而且这次失效是**阻塞在写请求里 await 的**——这正是
//! "POST/INSERT 慢约 9700ms、GET 仅 ~90ms、DB 仅 2ms" 的根因（与表无关）。
//!
//! 现在改为：
//! - 每张表维护一个版本号 key `qcv:{db}:{schema}:{table}`（整数）。
//! - 缓存 key 里带上当前版本号：`qc:{db}:{schema}:{table}:v{N}:{hash}`。
//! - 写操作只需 `INCR` 版本号（O(1)、一次 RTT），旧版本的缓存 key 立刻不可达，随其自身
//!   TTL 自然过期，**永不触发 keyspace 扫描**。
//!
//! 缓存 key: `qc:{database_id}:{schema}:{table}:v{version}:{hash(fingerprint)}`，TTL 默认 60 秒。

use sha2::{Digest, Sha256};

use crate::redis_manager::RedisManager;

const QUERY_CACHE_TTL: u64 = 60;
const QC_PREFIX: &str = "qc";
const QC_VERSION_PREFIX: &str = "qcv";
/// 版本号 key 的 TTL：远大于查询缓存 TTL（取 1 天）。只要表还在被读写就会被不断刷新；
/// 即使长时间无写入而过期、版本号回退到 0 也安全——彼时该表所有 60s TTL 的数据缓存早已过期。
const QC_VERSION_TTL: u64 = 86400;

pub struct QueryCache;

impl QueryCache {
    /// 为查询构造缓存 key（带表级版本号，旧版本天然不可达）。
    /// fingerprint 包含排序后的查询参数、行条件、列过滤等
    fn cache_key(
        database_id: i32,
        schema: &str,
        table: &str,
        fingerprint: &str,
        version: u64,
    ) -> String {
        let mut hasher = Sha256::new();
        hasher.update(fingerprint.as_bytes());
        let hash = hex::encode(hasher.finalize());
        format!(
            "{}:{}:{}:{}:v{}:{}",
            QC_PREFIX,
            database_id,
            schema,
            table,
            version,
            &hash[..16]
        )
    }

    /// 表级版本号 key
    fn version_key(database_id: i32, schema: &str, table: &str) -> String {
        format!("{}:{}:{}:{}", QC_VERSION_PREFIX, database_id, schema, table)
    }

    /// 读取表级版本号；缺失（未被写过）按 0 处理
    async fn current_version(
        redis: &RedisManager,
        database_id: i32,
        schema: &str,
        table: &str,
    ) -> u64 {
        let key = Self::version_key(database_id, schema, table);
        match redis.get(&key).await {
            Ok(Some(s)) => s.parse().unwrap_or(0),
            _ => 0,
        }
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
        let version = Self::current_version(redis, database_id, schema, table).await;
        let key = Self::cache_key(database_id, schema, table, fingerprint, version);
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
        let version = Self::current_version(redis, database_id, schema, table).await;
        let key = Self::cache_key(database_id, schema, table, fingerprint, version);
        let _ = redis.set_ex(&key, data, QUERY_CACHE_TTL).await;
    }

    /// 失效某张表的所有查询缓存（写操作后调用）。
    ///
    /// O(1)：只 `INCR` 表级版本号，旧版本的缓存 key 立刻不可达并随自身 TTL 过期。
    /// **不再做 keyspace 扫描**——这是修复写入路径 ~10s 阻塞的关键。
    pub async fn invalidate_table(
        redis: &RedisManager,
        database_id: i32,
        schema: &str,
        table: &str,
    ) {
        let key = Self::version_key(database_id, schema, table);
        let _ = redis.incr_refresh_expire(&key, QC_VERSION_TTL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_key_deterministic() {
        let k1 = QueryCache::cache_key(1, "public", "posts", "fp1", 0);
        let k2 = QueryCache::cache_key(1, "public", "posts", "fp1", 0);
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_cache_key_different_fingerprints() {
        let k1 = QueryCache::cache_key(1, "public", "posts", "fp1", 0);
        let k2 = QueryCache::cache_key(1, "public", "posts", "fp2", 0);
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_cache_key_different_tables() {
        let k1 = QueryCache::cache_key(1, "public", "posts", "fp1", 0);
        let k2 = QueryCache::cache_key(1, "public", "users", "fp1", 0);
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_cache_key_version_changes_key() {
        // 版本号自增后 key 必须不同：旧缓存因此天然不可达（失效）。
        let k1 = QueryCache::cache_key(1, "public", "posts", "fp1", 0);
        let k2 = QueryCache::cache_key(1, "public", "posts", "fp1", 1);
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_version_key_format() {
        let key = QueryCache::version_key(5, "myschema", "orders");
        assert_eq!(key, "qcv:5:myschema:orders");
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
