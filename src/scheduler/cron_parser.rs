//! Cron 表达式 → next_run_at 计算。
//!
//! 输入是 5 字段 cron + IANA 时区。`cron` crate 接受 6 字段（含秒），所以
//! 我们在前面补一个 "0 " 把语义钉到 "整分钟触发"。
//!
//! 返回值统一是 UTC——所有调用方都用 UTC 比对 NOW()。

use chrono::{DateTime, Utc};
use std::str::FromStr;

use crate::error::AppError;

fn normalize(expr: &str) -> String {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    match parts.len() {
        5 => format!("0 {}", expr.trim()),
        6 => expr.to_string(),
        _ => expr.to_string(),
    }
}

/// 计算 `expr` 在 `tz` 时区下、`after` 之后的第一个触发时刻。
pub fn next_after(expr: &str, tz: &str, after: DateTime<Utc>) -> Result<DateTime<Utc>, AppError> {
    let tz: chrono_tz::Tz = tz
        .parse()
        .map_err(|_| AppError::InvalidQuery(format!("无效时区: {}", tz)))?;
    let schedule = cron::Schedule::from_str(&normalize(expr))
        .map_err(|e| AppError::InvalidQuery(format!("无效 cron 表达式: {}", e)))?;
    let local = after.with_timezone(&tz);
    let next = schedule
        .after(&local)
        .next()
        .ok_or_else(|| AppError::Internal("cron 表达式无下一个触发点".into()))?;
    Ok(next.with_timezone(&Utc))
}

/// 校验 cron 表达式 + 时区可解析，并返回 `after` 之后的前 `count` 个触发时刻。
/// 供 `/validate-cron` 用；`after` 参数化便于测试。
pub fn preview(
    expr: &str,
    tz: &str,
    after: DateTime<Utc>,
    count: usize,
) -> Result<Vec<DateTime<Utc>>, AppError> {
    let tz_parsed: chrono_tz::Tz = tz
        .parse()
        .map_err(|_| AppError::InvalidQuery(format!("无效时区: {}", tz)))?;
    let schedule = cron::Schedule::from_str(&normalize(expr))
        .map_err(|e| AppError::InvalidQuery(format!("无效 cron 表达式: {}", e)))?;
    let local = after.with_timezone(&tz_parsed);
    Ok(schedule
        .after(&local)
        .take(count)
        .map(|dt| dt.with_timezone(&Utc))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parses_every_6h() {
        let after = Utc.with_ymd_and_hms(2026, 5, 14, 12, 30, 0).unwrap();
        let next = next_after("0 */6 * * *", "UTC", after).unwrap();
        // */6 在 0、6、12、18 触发；12:30 之后下一个是 18:00。
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 5, 14, 18, 0, 0).unwrap());
    }

    #[test]
    fn parses_every_minute() {
        let after = Utc.with_ymd_and_hms(2026, 5, 14, 12, 30, 45).unwrap();
        let next = next_after("* * * * *", "UTC", after).unwrap();
        // 当前秒 45，下一分钟整点。
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 5, 14, 12, 31, 0).unwrap());
    }

    #[test]
    fn timezone_shifts_trigger() {
        // 02:00 NY (EST, UTC-5) = 07:00 UTC。仅覆盖稳定 EST 期间——
        // DST 跳变行为见下面两个 timezone_handles_dst_* 测试。
        let after = Utc.with_ymd_and_hms(2026, 1, 15, 0, 0, 0).unwrap(); // 2026-01-15 是 EST
        let next = next_after("0 2 * * *", "America/New_York", after).unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 1, 15, 7, 0, 0).unwrap());
    }

    #[test]
    fn rejects_invalid_expr() {
        let after = Utc::now();
        assert!(next_after("not a cron", "UTC", after).is_err());
    }

    #[test]
    fn rejects_invalid_tz() {
        let after = Utc::now();
        assert!(next_after("* * * * *", "Mars/Olympus", after).is_err());
    }

    #[test]
    fn timezone_handles_dst_spring_forward() {
        // 美东 DST 开始日（2026-03-08）：本地 02:00→03:00 跳跃，
        // 所以 cron "0 2 * * *" 在 3 月 8 日"找不到"02:00 EST，自动顺延到 3 月 9 日 02:00 EDT。
        // 经验证（cron 0.12 + chrono-tz 0.8）：spring-forward 当天的不存在小时被跳过，
        // 下一次触发出现在次日同一本地小时（已切到 EDT, UTC-4）。
        let from = Utc.with_ymd_and_hms(2026, 3, 8, 6, 0, 0).unwrap(); // 01:00 EST
        let next = next_after("0 2 * * *", "America/New_York", from).unwrap();
        // 2026-03-09 02:00 EDT = 2026-03-09 06:00 UTC
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 3, 9, 6, 0, 0).unwrap());
    }

    #[test]
    fn timezone_handles_dst_fall_back() {
        // 美东 DST 结束日（2026-11-01）：02:00 EDT 时钟回拨到 01:00 EST，
        // 因此 01:00–02:00 这个本地区间出现两次（EDT 一次、EST 一次），
        // 而本地 02:00 整点在当天仅出现一次（02:00 EST，回拨之后）。
        // 经验证（cron 0.12 + chrono-tz 0.8）：cron "0 2 * * *" 命中那个唯一的 02:00 EST。
        let from = Utc.with_ymd_and_hms(2026, 11, 1, 5, 0, 0).unwrap(); // 01:00 EDT
        let next = next_after("0 2 * * *", "America/New_York", from).unwrap();
        // 2026-11-01 02:00 EST = 2026-11-01 07:00 UTC
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 11, 1, 7, 0, 0).unwrap());
    }

    #[test]
    fn preview_returns_n_times() {
        let after = Utc.with_ymd_and_hms(2026, 5, 14, 0, 0, 0).unwrap();
        let times = preview("0 */6 * * *", "UTC", after, 4).unwrap();
        assert_eq!(times.len(), 4);
        assert_eq!(times[0], Utc.with_ymd_and_hms(2026, 5, 14, 6, 0, 0).unwrap());
        assert_eq!(times[3], Utc.with_ymd_and_hms(2026, 5, 15, 0, 0, 0).unwrap());
    }
}
