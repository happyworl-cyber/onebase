//! 精选 Redis 命令执行层。
//!
//! 数据 API（`/api/redis-connections/:id/exec`）与工作流 `redis` 节点共用本模块，
//! 保证两条路径行为一致。只暴露常用、安全的命令；`FLUSHALL` / `CONFIG` / `KEYS *`
//! 这类危险 / 阻塞命令**不在集合内**，从源头杜绝而非靠黑名单。
//!
//! 入参统一为一个 JSON 对象（`args`），字段按 `op` 取用：
//!   - key: string           作用的主键
//!   - value: any            SET / *PUSH 的值（非字符串会 JSON 序列化后存储）
//!   - values: any[]         LPUSH / RPUSH 多值
//!   - members: any[]        SADD 多成员
//!   - field: string         HGET / HSET 的字段
//!   - ttl: int              SET / EXPIRE 的过期秒数
//!   - nx: bool              SET 是否 NX（仅当不存在时写入）
//!   - pattern: string       KEYS（内部走 SCAN）匹配模式
//!   - start / stop: int     LRANGE / ZREMRANGEBYRANK 区间
//!   - count: int            KEYS 扫描上限（默认 1000，封顶 10000）
//!   - member: string        ZADD 的成员
//!   - score: number         ZADD 的分值（由调用方传入，不在此层取当前时间）

use redis::aio::ConnectionManager;
use serde_json::{json, Value as JsonValue};
use std::time::Duration;

use crate::error::{AppError, Result};

/// 单条命令执行超时。Redis 正常 <1ms；给个上限避免劣化实例拖垮请求。
const OP_TIMEOUT: Duration = Duration::from_secs(5);
/// KEYS（SCAN）默认 / 最大返回条数，防一次性拉爆内存。
const SCAN_DEFAULT_COUNT: usize = 1000;
const SCAN_MAX_COUNT: usize = 10000;

/// 支持的操作清单（用于校验与前端下拉）。
pub const SUPPORTED_OPS: &[&str] = &[
    "get",
    "set",
    "del",
    "exists",
    "expire",
    "ttl",
    "incr",
    "decr",
    "keys",
    "hget",
    "hset",
    "hgetall",
    "lpush",
    "rpush",
    "lrange",
    "sadd",
    "smembers",
    "zadd",
    "zcard",
    "zremrangebyrank",
];

/// 判断某 op 是否为写操作（用于工作流 dry_run / 生产只读拦截）。
pub fn is_write_op(op: &str) -> bool {
    matches!(
        op,
        "set"
            | "del"
            | "expire"
            | "incr"
            | "decr"
            | "hset"
            | "lpush"
            | "rpush"
            | "sadd"
            | "zadd"
            | "zremrangebyrank"
    )
}

/// 把一条 redis future 套上超时，错误归一成 AppError。
async fn timed<T>(
    label: &str,
    fut: impl std::future::Future<Output = redis::RedisResult<T>>,
) -> Result<T> {
    match tokio::time::timeout(OP_TIMEOUT, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(AppError::Internal(format!("Redis {label} 失败: {e}"))),
        Err(_) => Err(AppError::ServiceUnavailable(format!(
            "Redis {label} 超时（>{}s）",
            OP_TIMEOUT.as_secs()
        ))),
    }
}

fn arg_str<'a>(args: &'a JsonValue, name: &str) -> Result<&'a str> {
    args.get(name)
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::InvalidQuery(format!("缺少字符串参数 `{name}`")))
}

fn arg_i64(args: &JsonValue, name: &str) -> Result<i64> {
    args.get(name)
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AppError::InvalidQuery(format!("缺少整数参数 `{name}`")))
}

fn arg_f64(args: &JsonValue, name: &str) -> Result<f64> {
    args.get(name)
        .and_then(|v| v.as_f64())
        .ok_or_else(|| AppError::InvalidQuery(format!("缺少数值参数 `{name}`")))
}

/// 把任意 JSON 值转成可作为 redis 参数的字符串：字符串原样，标量转字面量，
/// 对象 / 数组 JSON 序列化后存储。
fn value_to_redis_arg(v: &JsonValue) -> String {
    match v {
        JsonValue::String(s) => s.clone(),
        JsonValue::Null => String::new(),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// 取一组值：接受 JSON 数组（数据 API 直接传）或逗号/换行分隔的字符串
/// （工作流节点里手填更方便）。两种都归一成 Vec<String>。
fn arg_value_list(args: &JsonValue, name: &str) -> Result<Vec<String>> {
    match args.get(name) {
        Some(JsonValue::Array(arr)) => {
            if arr.is_empty() {
                return Err(AppError::InvalidQuery(format!(
                    "参数 `{name}` 不能为空数组"
                )));
            }
            Ok(arr.iter().map(value_to_redis_arg).collect())
        }
        Some(JsonValue::String(s)) => {
            let parts: Vec<String> = s
                .split(['\n', ','])
                .map(|x| x.trim())
                .filter(|x| !x.is_empty())
                .map(str::to_string)
                .collect();
            if parts.is_empty() {
                return Err(AppError::InvalidQuery(format!("参数 `{name}` 不能为空")));
            }
            Ok(parts)
        }
        _ => Err(AppError::InvalidQuery(format!(
            "缺少数组 / 字符串参数 `{name}`"
        ))),
    }
}

/// 执行一条精选命令。
pub async fn execute(conn: &ConnectionManager, op: &str, args: &JsonValue) -> Result<JsonValue> {
    let mut c = conn.clone();
    let op_lc = op.to_lowercase();

    match op_lc.as_str() {
        "get" => {
            let key = arg_str(args, "key")?;
            let v: Option<String> =
                timed("GET", redis::cmd("GET").arg(key).query_async(&mut c)).await?;
            Ok(json!({ "value": v }))
        }
        "set" => {
            let key = arg_str(args, "key")?;
            let value = value_to_redis_arg(
                args.get("value")
                    .ok_or_else(|| AppError::InvalidQuery("缺少参数 `value`".into()))?,
            );
            let mut cmd = redis::cmd("SET");
            cmd.arg(key).arg(value);
            if let Some(ttl) = args.get("ttl").and_then(|v| v.as_i64()) {
                if ttl > 0 {
                    cmd.arg("EX").arg(ttl);
                }
            }
            let nx = args.get("nx").and_then(|v| v.as_bool()).unwrap_or(false);
            if nx {
                cmd.arg("NX");
            }
            // NX 未写入时返回 nil；用 Option<String> 承接。
            let res: Option<String> = timed("SET", cmd.query_async(&mut c)).await?;
            Ok(json!({ "ok": res.is_some() }))
        }
        "del" => {
            // 支持单 key（key）或多 key（keys[]）。
            let keys: Vec<String> = if let Some(list) = args.get("keys").and_then(|v| v.as_array())
            {
                list.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            } else {
                vec![arg_str(args, "key")?.to_string()]
            };
            if keys.is_empty() {
                return Err(AppError::InvalidQuery("del 需要 key 或非空 keys[]".into()));
            }
            let deleted: i64 =
                timed("DEL", redis::cmd("DEL").arg(&keys).query_async(&mut c)).await?;
            Ok(json!({ "deleted": deleted }))
        }
        "exists" => {
            let key = arg_str(args, "key")?;
            let n: i64 = timed("EXISTS", redis::cmd("EXISTS").arg(key).query_async(&mut c)).await?;
            Ok(json!({ "exists": n > 0 }))
        }
        "expire" => {
            let key = arg_str(args, "key")?;
            let ttl = arg_i64(args, "ttl")?;
            let n: i64 = timed(
                "EXPIRE",
                redis::cmd("EXPIRE").arg(key).arg(ttl).query_async(&mut c),
            )
            .await?;
            Ok(json!({ "ok": n == 1 }))
        }
        "ttl" => {
            let key = arg_str(args, "key")?;
            let t: i64 = timed("TTL", redis::cmd("TTL").arg(key).query_async(&mut c)).await?;
            Ok(json!({ "ttl": t }))
        }
        "incr" => {
            let key = arg_str(args, "key")?;
            let n: i64 = timed("INCR", redis::cmd("INCR").arg(key).query_async(&mut c)).await?;
            Ok(json!({ "value": n }))
        }
        "decr" => {
            let key = arg_str(args, "key")?;
            let n: i64 = timed("DECR", redis::cmd("DECR").arg(key).query_async(&mut c)).await?;
            Ok(json!({ "value": n }))
        }
        "keys" => {
            let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("*");
            let cap = args
                .get("count")
                .and_then(|v| v.as_u64())
                .map(|n| (n as usize).min(SCAN_MAX_COUNT))
                .unwrap_or(SCAN_DEFAULT_COUNT);
            let keys = scan_keys(&mut c, pattern, cap).await?;
            let truncated = keys.len() >= cap;
            Ok(json!({ "keys": keys, "truncated": truncated }))
        }
        "hget" => {
            let key = arg_str(args, "key")?;
            let field = arg_str(args, "field")?;
            let v: Option<String> = timed(
                "HGET",
                redis::cmd("HGET").arg(key).arg(field).query_async(&mut c),
            )
            .await?;
            Ok(json!({ "value": v }))
        }
        "hset" => {
            let key = arg_str(args, "key")?;
            let field = arg_str(args, "field")?;
            let value = value_to_redis_arg(
                args.get("value")
                    .ok_or_else(|| AppError::InvalidQuery("缺少参数 `value`".into()))?,
            );
            let added: i64 = timed(
                "HSET",
                redis::cmd("HSET")
                    .arg(key)
                    .arg(field)
                    .arg(value)
                    .query_async(&mut c),
            )
            .await?;
            Ok(json!({ "added": added }))
        }
        "hgetall" => {
            let key = arg_str(args, "key")?;
            let map: std::collections::HashMap<String, String> = timed(
                "HGETALL",
                redis::cmd("HGETALL").arg(key).query_async(&mut c),
            )
            .await?;
            Ok(json!({ "value": map }))
        }
        "lpush" => {
            let key = arg_str(args, "key")?;
            let values = list_values(args)?;
            let len: i64 = timed(
                "LPUSH",
                redis::cmd("LPUSH")
                    .arg(key)
                    .arg(&values)
                    .query_async(&mut c),
            )
            .await?;
            Ok(json!({ "length": len }))
        }
        "rpush" => {
            let key = arg_str(args, "key")?;
            let values = list_values(args)?;
            let len: i64 = timed(
                "RPUSH",
                redis::cmd("RPUSH")
                    .arg(key)
                    .arg(&values)
                    .query_async(&mut c),
            )
            .await?;
            Ok(json!({ "length": len }))
        }
        "lrange" => {
            let key = arg_str(args, "key")?;
            let start = args.get("start").and_then(|v| v.as_i64()).unwrap_or(0);
            let stop = args.get("stop").and_then(|v| v.as_i64()).unwrap_or(-1);
            let items: Vec<String> = timed(
                "LRANGE",
                redis::cmd("LRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(stop)
                    .query_async(&mut c),
            )
            .await?;
            Ok(json!({ "items": items }))
        }
        "sadd" => {
            let key = arg_str(args, "key")?;
            let members = arg_value_list(args, "members")?;
            let added: i64 = timed(
                "SADD",
                redis::cmd("SADD")
                    .arg(key)
                    .arg(&members)
                    .query_async(&mut c),
            )
            .await?;
            Ok(json!({ "added": added }))
        }
        "smembers" => {
            let key = arg_str(args, "key")?;
            let members: Vec<String> = timed(
                "SMEMBERS",
                redis::cmd("SMEMBERS").arg(key).query_async(&mut c),
            )
            .await?;
            Ok(json!({ "members": members }))
        }
        "zadd" => {
            let key = arg_str(args, "key")?;
            let member = arg_str(args, "member")?;
            let score = arg_f64(args, "score")?;
            let added: i64 = timed(
                "ZADD",
                redis::cmd("ZADD")
                    .arg(key)
                    .arg(score)
                    .arg(member)
                    .query_async(&mut c),
            )
            .await?;
            Ok(json!({ "added": added }))
        }
        "zcard" => {
            let key = arg_str(args, "key")?;
            let n: i64 = timed("ZCARD", redis::cmd("ZCARD").arg(key).query_async(&mut c)).await?;
            Ok(json!({ "count": n }))
        }
        "zremrangebyrank" => {
            let key = arg_str(args, "key")?;
            let start = arg_i64(args, "start")?;
            let stop = arg_i64(args, "stop")?;
            let removed: i64 = timed(
                "ZREMRANGEBYRANK",
                redis::cmd("ZREMRANGEBYRANK")
                    .arg(key)
                    .arg(start)
                    .arg(stop)
                    .query_async(&mut c),
            )
            .await?;
            Ok(json!({ "removed": removed }))
        }
        other => Err(AppError::InvalidQuery(format!(
            "不支持的 Redis 操作 `{other}`（支持：{})",
            SUPPORTED_OPS.join(", ")
        ))),
    }
}

/// LPUSH / RPUSH 取值：优先 values[]，否则单个 value。
fn list_values(args: &JsonValue) -> Result<Vec<String>> {
    if args.get("values").is_some() {
        arg_value_list(args, "values")
    } else if let Some(v) = args.get("value") {
        Ok(vec![value_to_redis_arg(v)])
    } else {
        Err(AppError::InvalidQuery("需要 value 或 values[]".into()))
    }
}

/// 用 SCAN 分批取 key，累计到 cap 即停。**不用 `KEYS`**（后者在大 keyspace 上阻塞）。
async fn scan_keys(conn: &mut ConnectionManager, pattern: &str, cap: usize) -> Result<Vec<String>> {
    let inner = async {
        let mut cursor: u64 = 0;
        let mut out: Vec<String> = Vec::new();
        loop {
            let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(200)
                .query_async(conn)
                .await
                .map_err(|e| AppError::Internal(format!("Redis SCAN 失败: {e}")))?;
            out.extend(batch);
            cursor = next;
            if cursor == 0 || out.len() >= cap {
                break;
            }
        }
        out.truncate(cap);
        Ok::<Vec<String>, AppError>(out)
    };
    match tokio::time::timeout(OP_TIMEOUT, inner).await {
        Ok(r) => r,
        Err(_) => Err(AppError::ServiceUnavailable(format!(
            "Redis SCAN 超时（>{}s）",
            OP_TIMEOUT.as_secs()
        ))),
    }
}
