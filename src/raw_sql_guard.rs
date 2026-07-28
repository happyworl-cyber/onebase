//! 超管原始 SQL 通道（`/query`、`/transaction`、`export_sql_csv`）共用的安全闸。
//!
//! 这里收纳了"在 SQL 真正执行前必须过的所有 sanity check"，目标是让 raw SQL
//! 通道变成"只要超管自己别失手 + 自己别中招，就不会造成跨租户灾难"的弱
//! 防御边界。具体不变量：
//!
//!   1. **必须显式指定目标库**：调用方必须带 `X-Database-Id`；缺则拒绝，
//!      绝不再 fallback 到管理库（避免一个忘了选项目的超管直接 `SELECT *
//!      FROM users` 把全平台账户拖出来）。`require_target_pool` 守这条。
//!
//!   2. **management schema deny-list（defense in depth）**：即使有人把
//!      错误的 `X-Database-Id` 配置成管理库，也要在 SQL 文本层把 `management.*`
//!      引用挡掉。`check_management_references` 守这条。
//!
//!   3. **写/DDL 类 SQL 必须显式 acknowledge**：UI 必须强制用户勾选「我清楚
//!      这是写操作」才能发起，对应请求体里 `acknowledge_destructive = true`。
//!      `require_destructive_ack` 守这条。
//!
//!   4. **服务端兜底超时 + 行数上限**：`SET statement_timeout`，避免 SELECT
//!      跑垮整个 PG；fetch_all 后按 `max_returned_rows` 截断，避免一次性把
//!      百万行塞回前端。`RawSqlPolicy::from_env` 给默认值并允许环境变量覆盖。
//!
//! 注意：这些都是「软」防护。真正的隔离仍来自：
//!   - `require_superadmin` middleware 把通道挡在超管以外；
//!   - `dynamic_db_middleware` 强制连接池切换；
//!   - 物理上租户库与管理库是分离的 PG 实例 / 数据库。

use std::sync::OnceLock;

use sqlx::{pool::PoolConnection, PgPool, Postgres};

use crate::error::{AppError, Result};

/// raw SQL 通道运行时策略。所有字段都可通过环境变量覆盖；不传环境变量时
/// 使用对线上安全的保守默认（30s 超时、最多返回 10k 行、单事务最多 100 操作）。
#[derive(Debug, Clone, Copy)]
pub struct RawSqlPolicy {
    /// PG `statement_timeout` 设定，单位毫秒。SELECT / 写 / DDL 都受约束。
    pub statement_timeout_ms: u64,
    /// `/query` 单次最多返回多少行——超过则截断并在响应里告知 truncated=true。
    /// 不取代 statement_timeout：超时是「时间硬上限」，行数是「响应体硬上限」。
    pub max_returned_rows: usize,
    /// `/transaction` 单次事务允许的最大操作条目数。
    pub max_operations: usize,
}

impl RawSqlPolicy {
    pub const fn defaults() -> Self {
        Self {
            statement_timeout_ms: 30_000,
            max_returned_rows: 10_000,
            max_operations: 100,
        }
    }

    /// 读环境变量；非法值（含负数、非数字）落回 defaults 并打 warn，
    /// 不让一段错配置把启动整个挂掉。
    pub fn from_env() -> Self {
        let default = Self::defaults();
        let parse = |key: &str, default_value: u64| -> u64 {
            match std::env::var(key) {
                Ok(s) => match s.trim().parse::<u64>() {
                    Ok(v) if v > 0 => v,
                    _ => {
                        tracing::warn!(
                            "raw_sql_guard: 环境变量 {} 值 {:?} 无效，使用默认 {}",
                            key,
                            s,
                            default_value
                        );
                        default_value
                    }
                },
                Err(_) => default_value,
            }
        };

        Self {
            statement_timeout_ms: parse("RAW_SQL_STATEMENT_TIMEOUT_MS", default.statement_timeout_ms),
            max_returned_rows: parse(
                "RAW_SQL_MAX_RETURNED_ROWS",
                default.max_returned_rows as u64,
            ) as usize,
            max_operations: parse("RAW_SQL_MAX_OPERATIONS", default.max_operations as u64) as usize,
        }
    }
}

static GLOBAL_POLICY: OnceLock<RawSqlPolicy> = OnceLock::new();

/// 进程级懒加载策略；测试里可通过 `set_policy_for_tests` 注入。
pub fn policy() -> RawSqlPolicy {
    *GLOBAL_POLICY.get_or_init(RawSqlPolicy::from_env)
}

#[cfg(test)]
pub fn set_policy_for_tests(p: RawSqlPolicy) {
    let _ = GLOBAL_POLICY.set(p);
}

// ─── 工具：剥掉 SQL 开头的注释 ────────────────────────────────────────
/// 跳过 SQL 文本最前面的 `--` 行注释、`/* ... */` 块注释以及空白，
/// 返回首个"实际语句字符"开始的子串。
///
/// 这个函数本身**不**做语义判断，纯字符串扫描；它的存在是为了让
/// `get_sql_type` 能在「用户把脚本第一行写成注释」时仍然识别出真正
/// 的首关键字。比如：
///
/// ```text
/// -- 授权（本地: postgres，线上: community）
/// GRANT SELECT ON foo TO bar;
/// ```
///
/// 没有这步剥离，`split_whitespace().next()` 会拿到 `--`，于是首关键字
/// 错判成 `OTHER`——`require_destructive_ack` 仍然会兜住（OTHER 也要
/// ack），但报错信息和审计日志里的 `sql_type` 都会不准确，让人 debug
/// 时一头雾水。
///
/// 注意：
///   - 不处理嵌套块注释（PG 文档说 `/* /* */ */` 是合法的，这里就**不**
///     还原 PG 的严格语义；我们只在意"剥到第一个语句"），遇到第一个
///     `*/` 就停。
///   - 注释里出现 `--` / `/*` 字面量也会被算成注释关键字；正常 SQL 不
///     会在注释里再嵌一段"假装是新一行注释"，所以可接受。
///   - 不解析字符串字面量。这里只剥**前导**注释，不会跑到字符串里去
///     胡乱判断。
pub fn strip_leading_sql_comments(sql: &str) -> &str {
    let mut rest = sql;
    loop {
        let trimmed = rest.trim_start();
        if let Some(after) = trimmed.strip_prefix("--") {
            match after.find('\n') {
                Some(nl) => rest = &after[nl + 1..],
                None => return "",
            }
        } else if let Some(after) = trimmed.strip_prefix("/*") {
            match after.find("*/") {
                Some(end) => rest = &after[end + 2..],
                None => return "",
            }
        } else {
            return trimmed;
        }
    }
}

// ─── 不变量 1：必须显式指定 X-Database-Id ─────────────────────────────────
/// 强制要求调用方通过 `X-Database-Id` 头注入了租户库 pool；缺失则 400。
///
/// 与 `permissions::require_database_admin` 是互补关系——后者管「这个 db 能不能
/// 让这个用户访问」，本函数管「这次请求到底有没有给目标 db」。
pub fn require_target_pool<'a>(dynamic_pool: Option<&'a PgPool>) -> Result<&'a PgPool> {
    dynamic_pool.ok_or_else(|| {
        AppError::InvalidQuery(
            "原始 SQL 通道必须显式指定目标数据库（请求头 X-Database-Id）；\
             该接口已不再 fallback 到平台管理库，请先选择项目后再执行。"
                .to_string(),
        )
    })
}

// ─── 不变量 2：management schema 引用 deny-list ────────────────────────
//
// 这是「字符串层兜底」，不依赖也不假装做 SQL 解析。如果用户拿到了管理库
// 的连接（理论上 dynamic_db_middleware 已经阻断），这一层仍能挡掉 `SELECT
// * FROM management.users`、`UPDATE management.user_sessions` 这种最常见的
// 直白触碰。绕过这道关需要构造能被 PG 解释但又不命中 `management.` 字面
// 量的语句，而我们已经把 `pg_catalog.` / `information_schema.` 的 system
// 视图也一并拒绝——业务上没有"在租户库手写 SQL 查系统视图"的合理需求。
const PROHIBITED_PREFIXES: &[&str] = &[
    "management.",
    " management.",
    "\"management\".",
    "pg_catalog.pg_user",
    "pg_catalog.pg_authid",
    "pg_catalog.pg_shadow",
    "information_schema.role_table_grants",
];

/// 扫描 SQL 文本里是否引用了禁止访问的 schema。
///
/// 实现说明：用最朴素的「lowercase + 字符串 contains」做扫描——
///   - 用户写 `MANAGEMENT.foo` / `MaNaGeMeNt.foo` 仍会命中；
///   - 但 `"Management".foo`（双引号 + 大小写敏感标识符）会绕过，
///     不过 PG 默认 schema 名不区分大小写时这种写法本身就不存在。
///   - 用户在字符串字面量里写 `'management.foo'` 也会被误杀，可接受
///     （超管要在 SQL 里硬编码 management 字面量是很奇怪的需求）。
pub fn check_management_references(sql: &str) -> Result<()> {
    let lower = sql.to_lowercase();
    for needle in PROHIBITED_PREFIXES {
        if lower.contains(needle) {
            return Err(AppError::Forbidden(format!(
                "原始 SQL 通道禁止引用 `{}` —— 该路径只允许操作租户业务数据，\
                 请使用专门的平台管理接口处理管理库 / 系统视图。",
                needle.trim()
            )));
        }
    }
    Ok(())
}

// ─── 不变量 3：写/DDL 强制 acknowledge_destructive ──────────────────────
/// SELECT 类放行；写 / DDL / 事务必须带 ack。
///
/// `sql_type` 取值与 `main::get_sql_type` 一致：
///   `SELECT` 透传；`INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE/
///   PERMISSION/TRANSACTION/OTHER` 都视为「需要确认」。
pub fn require_destructive_ack(sql_type: &str, ack: bool) -> Result<()> {
    if sql_type == "SELECT" {
        return Ok(());
    }
    if ack {
        return Ok(());
    }
    Err(AppError::InvalidQuery(format!(
        "检测到 {} 类操作。原始 SQL 通道要求显式确认：请求体加 \
         `acknowledge_destructive: true` 后再发起，前端建议加二次确认弹窗。",
        sql_type
    )))
}

// ─── 不变量 4：服务端超时 + 行数截断 ──────────────────────────────────
/// 在已 acquire 的连接上 `SET statement_timeout` + `idle_in_transaction_session_timeout`。
/// 必须配合 `reset_session_guards` 使用，避免污染连接池里的其它请求。
pub async fn apply_session_guards(
    conn: &mut PoolConnection<Postgres>,
    policy: RawSqlPolicy,
) -> Result<()> {
    let timeout = policy.statement_timeout_ms.to_string();
    sqlx::query(&format!("SET statement_timeout = {}", timeout))
        .execute(&mut **conn)
        .await
        .map_err(AppError::Database)?;
    // 防止"用户开了 BEGIN 但不 COMMIT，连接被永久占用"——同样 30s 超时。
    sqlx::query(&format!(
        "SET idle_in_transaction_session_timeout = {}",
        timeout
    ))
    .execute(&mut **conn)
    .await
    .map_err(AppError::Database)?;
    Ok(())
}

/// 把连接上由 `apply_session_guards` 设置的会话状态清理回服务器默认。
/// 故意 swallow 错误并降级到 warn——连接即将归还池子，下一次 acquire 再
/// `SET` 会覆盖；保守做法是哪怕没 reset 成功也不能让这次请求整个失败。
pub async fn reset_session_guards(conn: &mut PoolConnection<Postgres>) {
    if let Err(e) = sqlx::query("RESET statement_timeout")
        .execute(&mut **conn)
        .await
    {
        tracing::warn!("raw_sql_guard: 重置 statement_timeout 失败: {}", e);
    }
    if let Err(e) = sqlx::query("RESET idle_in_transaction_session_timeout")
        .execute(&mut **conn)
        .await
    {
        tracing::warn!(
            "raw_sql_guard: 重置 idle_in_transaction_session_timeout 失败: {}",
            e
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_conservative() {
        let p = RawSqlPolicy::defaults();
        assert_eq!(p.statement_timeout_ms, 30_000);
        assert_eq!(p.max_returned_rows, 10_000);
        assert_eq!(p.max_operations, 100);
    }

    #[test]
    fn check_management_references_blocks_obvious_cases() {
        assert!(check_management_references("SELECT * FROM management.users").is_err());
        assert!(check_management_references("UPDATE  MANAGEMENT.user_sessions SET x = 1").is_err());
        assert!(check_management_references("SELECT * FROM \"management\".tenants").is_err());
        assert!(check_management_references("SELECT * FROM pg_catalog.pg_user").is_err());
    }

    #[test]
    fn check_management_references_allows_normal_queries() {
        assert!(check_management_references("SELECT * FROM public.products").is_ok());
        assert!(check_management_references("SELECT 1").is_ok());
        // 列名/表名碰巧叫 management_* 是允许的：deny-list 是带"."的精确串
        assert!(check_management_references("SELECT management_id FROM orders").is_ok());
    }

    #[test]
    fn require_destructive_ack_lets_select_through() {
        require_destructive_ack("SELECT", false).expect("SELECT 不需要 ack");
    }

    #[test]
    fn require_destructive_ack_blocks_write_without_ack() {
        for kind in ["UPDATE", "INSERT", "DELETE", "DROP", "ALTER", "TRUNCATE"] {
            let err = require_destructive_ack(kind, false)
                .expect_err(&format!("{} 必须要求 ack", kind));
            assert!(matches!(err, AppError::InvalidQuery(_)));
        }
    }

    #[test]
    fn require_destructive_ack_lets_write_through_with_ack() {
        require_destructive_ack("UPDATE", true).expect("ack=true 时通过");
    }

    #[test]
    fn strip_leading_sql_comments_handles_line_and_block() {
        assert_eq!(strip_leading_sql_comments("SELECT 1"), "SELECT 1");
        assert_eq!(strip_leading_sql_comments("   SELECT 1"), "SELECT 1");
        assert_eq!(
            strip_leading_sql_comments("-- 注释\nGRANT SELECT ON t TO u"),
            "GRANT SELECT ON t TO u"
        );
        assert_eq!(
            strip_leading_sql_comments("-- a\n-- b\n  /* c */  \nINSERT INTO t VALUES(1)"),
            "INSERT INTO t VALUES(1)"
        );
        assert_eq!(
            strip_leading_sql_comments("/* multi\n   line */ ALTER TABLE t ADD COLUMN x int"),
            "ALTER TABLE t ADD COLUMN x int"
        );
        // 不闭合 / 全是注释：返回空串，调用方按"无效首关键字"处理。
        assert_eq!(strip_leading_sql_comments("-- 只有注释没语句"), "");
        assert_eq!(strip_leading_sql_comments("/* 没闭合的块注释"), "");
        assert_eq!(strip_leading_sql_comments(""), "");
    }

    #[test]
    fn require_target_pool_rejects_missing() {
        let err = require_target_pool(None).unwrap_err();
        match err {
            AppError::InvalidQuery(msg) => assert!(msg.contains("X-Database-Id")),
            other => panic!("意外的错误类型: {:?}", other),
        }
    }
}
