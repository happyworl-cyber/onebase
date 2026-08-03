use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

use chrono::{Datelike, FixedOffset, Timelike};

/// 同时执行的 cron 工作流数上限（并发闸门）。每个工作流执行都会向管理库池做多次读写，
/// 不限并发时一分钟内到期的大量工作流会瞬间抢光连接池。可用 `WORKFLOW_CRON_MAX_CONCURRENCY`
/// 覆盖；0 / 非法值回退默认 8。
fn cron_max_concurrency() -> usize {
    std::env::var("WORKFLOW_CRON_MAX_CONCURRENCY")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(8)
}

/// Cron 表达式求值时区：国区（北京时间，UTC+8，无夏令时）。
/// 用户按北京时间书写 cron；调度器把 UTC 现在时间换算到此时区再匹配。
fn cn_offset() -> FixedOffset {
    FixedOffset::east_opt(8 * 3600).expect("UTC+8 offset")
}

use crate::workflow_handlers::{self, Workflow};

/// 每分钟扫描 trigger_type='cron' 且 is_enabled=true 的工作流，
/// 根据 cron 表达式决定当前分钟是否应触发执行。
///
/// 多实例去重：生产多 Pod 部署时，每个 Pod 都会运行本扫描器。触发前先向
/// `management.workflow_cron_fires` 插入 `(workflow_id, fired_minute)`；唯一约束保证
/// 同一个工作流同一个计划分钟只有一个 Pod 能抢到 claim，避免重复执行。
pub fn start_cron_trigger(pool: sqlx::PgPool) -> JoinHandle<()> {
    tokio::spawn(async move {
        let max_concurrency = cron_max_concurrency();
        let sem = Arc::new(Semaphore::new(max_concurrency));
        tracing::info!(
            "工作流 Cron 触发器已启动 (max_concurrency={})",
            max_concurrency
        );
        loop {
            // 对齐到下一分钟整点再执行，避免启动时立即乱触发
            let now = chrono::Utc::now();
            let secs_to_next = 60 - now.second() as u64;
            tokio::time::sleep(Duration::from_secs(secs_to_next)).await;

            let tick_time = chrono::Utc::now();
            if let Err(e) = fire_due_workflows(&pool, tick_time, &sem).await {
                tracing::error!("cron 工作流触发失败: {}", e);
            }
        }
    })
}

async fn fire_due_workflows(
    pool: &sqlx::PgPool,
    now: chrono::DateTime<chrono::Utc>,
    sem: &Arc<Semaphore>,
) -> Result<(), sqlx::Error> {
    let workflows = sqlx::query_as::<_, Workflow>(
        "SELECT * FROM management.workflows WHERE trigger_type = 'cron' AND is_enabled = true",
    )
    .fetch_all(pool)
    .await?;

    // 分钟粒度时间桶（秒/纳秒清零），作为去重键的一部分。
    let fired_minute = now
        .with_second(0)
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(now);

    for wf in workflows {
        let schedule = wf
            .trigger_config
            .get("schedule")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if schedule.is_empty() || !cron_matches(schedule, now) {
            continue;
        }

        // ① 重叠防护：该工作流仍有 running 运行时跳过本次触发，避免高频 cron（如 */1）
        //    与长耗时工作流叠加成多份并发。
        let running: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM management.workflow_runs \
             WHERE workflow_id = $1 AND status = 'running')",
        )
        .bind(wf.id)
        .fetch_one(pool)
        .await
        .unwrap_or(false);
        if running {
            tracing::warn!(workflow_id = wf.id, slug = %wf.slug, "上一轮仍在运行，跳过本次 Cron 触发");
            continue;
        }

        // ② 去重抢占：唯一键 (workflow_id, fired_minute) 原子插入。多实例/多 tick 同分钟
        //    只有插入成功者执行，冲突者跳过 —— 解决多实例重复触发。
        let claimed = sqlx::query(
            "INSERT INTO management.workflow_cron_fires (workflow_id, fired_minute) \
             VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(wf.id)
        .bind(fired_minute)
        .execute(pool)
        .await;
        let claimed = matches!(&claimed, Ok(r) if r.rows_affected() == 1);
        if !claimed {
            // 冲突（已有实例/上次 tick 触发过该分钟）或插入失败：跳过。
            tracing::debug!(
                workflow_id = wf.id,
                slug = %wf.slug,
                fired_minute = %fired_minute,
                "Cron 工作流本分钟已由其他实例 claim，跳过"
            );
            continue;
        }

        tracing::info!(workflow_id = wf.id, slug = %wf.slug, "Cron 触发工作流");
        let pool_clone = pool.clone();
        let fired_at = fired_minute.to_rfc3339();
        // 并发闸门：拿不到 permit 就等，避免同一分钟大批到期工作流一次抢光管理库连接池。
        let permit = match sem.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => break, // Semaphore 关闭（进程收尾），停止派发。
        };
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(e) = workflow_handlers::execute_workflow_internal(
                &pool_clone,
                &wf,
                "cron",
                &serde_json::json!({ "fired_at": fired_at }),
                None,
            )
            .await
            {
                tracing::error!(workflow_id = wf.id, error = %e, "Cron 工作流执行失败");
            }
        });
    }

    // 定期清理去重表旧行（保留最近 2 天），避免无限增长。best-effort。
    let _ = sqlx::query(
        "DELETE FROM management.workflow_cron_fires WHERE fired_minute < NOW() - INTERVAL '2 days'",
    )
    .execute(pool)
    .await;

    Ok(())
}

/// 5字段标准 cron 匹配（分 时 日 月 周），按**北京时间（UTC+8）**求值。
/// 每个字段支持：`*`、具体数值、范围 `a-b`、步进 `*/n` 与 `a-b/n`、以及逗号列表 `a,b,c`。
/// 周字段 0-6（0=周日），额外接受 7 作为周日。不支持月份/星期的英文名。
///
/// 日(DOM)与周(DOW)的组合遵循标准 Vixie cron 语义：**两者都被限定**（非 `*` 且非 `*/n`）时
/// 取“或”（任一命中即触发，如 `0 0 13 * 5` = 每月13号或每周五）；只要有一个是 `*`/`*/n`
/// 则取“与”。
pub fn cron_matches(expr: &str, now_utc: chrono::DateTime<chrono::Utc>) -> bool {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return false;
    }
    let now = now_utc.with_timezone(&cn_offset());

    if !field_matches(parts[0], now.minute(), 0, 59, false)
        || !field_matches(parts[1], now.hour(), 0, 23, false)
        || !field_matches(parts[3], now.month(), 1, 12, false)
    {
        return false;
    }

    let dom_ok = field_matches(parts[2], now.day(), 1, 31, false);
    let dow_ok = field_matches(parts[4], now.weekday().num_days_from_sunday(), 0, 6, true);
    if is_restricted(parts[2]) && is_restricted(parts[4]) {
        dom_ok || dow_ok
    } else {
        dom_ok && dow_ok
    }
}

/// 该字段是否“被限定”：具体值/范围/列表算限定；`*` 与 `*/n` 视为不限定。
/// 用于判定 DOM/DOW 组合走“或”还是“与”（与 Vixie cron 一致）。
fn is_restricted(field: &str) -> bool {
    let t = field.trim();
    t != "*" && !t.starts_with('*')
}

/// 校验 cron 表达式是否合法（5 字段、各 token 语法与范围正确）。
/// 供工作流保存时后端校验，避免非法表达式静默永不触发。
pub fn validate_cron(expr: &str) -> Result<(), String> {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return Err("必须是 5 个字段（分 时 日 月 周），以空格分隔".to_string());
    }
    let specs: [(&str, u32, u32, bool, &str); 5] = [
        (parts[0], 0, 59, false, "分"),
        (parts[1], 0, 23, false, "时"),
        (parts[2], 1, 31, false, "日"),
        (parts[3], 1, 12, false, "月"),
        (parts[4], 0, 6, true, "周"),
    ];
    for (field, min, max, is_wd, name) in specs {
        validate_field(field, min, max, is_wd).map_err(|e| format!("{}字段 `{}` {}", name, field, e))?;
    }
    Ok(())
}

fn validate_field(field: &str, min: u32, max: u32, is_wd: bool) -> Result<(), String> {
    let tokens: Vec<&str> = field.split(',').map(str::trim).collect();
    if tokens.iter().any(|t| t.is_empty()) {
        return Err("含空 token（逗号使用有误）".to_string());
    }
    for token in tokens {
        validate_token(token, min, max, is_wd)?;
    }
    Ok(())
}

fn validate_token(token: &str, min: u32, max: u32, is_wd: bool) -> Result<(), String> {
    let (range_part, has_step) = match token.split_once('/') {
        Some((r, s)) => {
            let step = s
                .parse::<u32>()
                .map_err(|_| "步进不是数字".to_string())?;
            if step == 0 {
                return Err("步进不能为 0".to_string());
            }
            (r, true)
        }
        None => (token, false),
    };

    if range_part == "*" {
        return Ok(());
    }
    if let Some((a, b)) = range_part.split_once('-') {
        let a = parse_num_checked(a, min, max, is_wd)?;
        let b = parse_num_checked(b, min, max, is_wd)?;
        if a > b {
            return Err("范围起点大于终点".to_string());
        }
        return Ok(());
    }
    // 纯数字（可带步进）
    parse_num_checked(range_part, min, max, is_wd)?;
    let _ = has_step;
    Ok(())
}

fn parse_num_checked(s: &str, min: u32, max: u32, is_wd: bool) -> Result<u32, String> {
    let n = s
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("`{}` 不是合法数字", s))?;
    let n = if is_wd && n == 7 { 0 } else { n };
    if n < min || n > max {
        return Err(format!("`{}` 超出范围 {}-{}", s, min, max));
    }
    Ok(n)
}

/// 单个 cron 字段匹配：逗号分隔的多个 token，任一命中即算命中。
fn field_matches(pattern: &str, value: u32, min: u32, max: u32, is_weekday: bool) -> bool {
    pattern
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .any(|token| token_matches(token, value, min, max, is_weekday))
}

/// 解析并匹配单个 token：支持 `*`、`n`、`a-b`、`*/s`、`a-b/s`、`n/s`。
fn token_matches(token: &str, value: u32, min: u32, max: u32, is_weekday: bool) -> bool {
    let (range_part, step) = match token.split_once('/') {
        Some((r, s)) => match s.parse::<u32>().ok().filter(|n| *n > 0) {
            Some(st) => (r, st),
            None => return false,
        },
        None => (token, 1),
    };

    let (start, end) = if range_part == "*" {
        (min, max)
    } else if let Some((a, b)) = range_part.split_once('-') {
        match (parse_field_num(a, is_weekday), parse_field_num(b, is_weekday)) {
            (Some(a), Some(b)) => (a, b),
            _ => return false,
        }
    } else {
        match parse_field_num(range_part, is_weekday) {
            // 纯数字带步进（如 "5/15"）表示从该值起到上界、按步进取；无步进则精确匹配。
            Some(n) if token.contains('/') => (n, max),
            Some(n) => return n == value,
            None => return false,
        }
    };

    if start > end || value < start || value > end {
        return false;
    }
    (value - start) % step == 0
}

/// 解析字段中的数字；周字段允许 7 表示周日（归一到 0）。
fn parse_field_num(s: &str, is_weekday: bool) -> Option<u32> {
    let n = s.trim().parse::<u32>().ok()?;
    if is_weekday && n == 7 {
        Some(0)
    } else {
        Some(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 以**北京时间**构造 2026-06-09（周二）hour:min，再转成 UTC 传入。
    /// 这样 cron_matches 换算回北京时间后，字段值恰为这里写的 hour/min，测试语义直观。
    fn dt(hour: u32, min: u32) -> chrono::DateTime<chrono::Utc> {
        cn_offset()
            .with_ymd_and_hms(2026, 6, 9, hour, min, 0)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn test_every_hour_on_minute_zero() {
        assert!(cron_matches("0 * * * *", dt(0, 0)));
        assert!(cron_matches("0 * * * *", dt(3, 0)));
        assert!(!cron_matches("0 * * * *", dt(3, 1)));
        assert!(!cron_matches("0 * * * *", dt(3, 59)));
    }

    #[test]
    fn test_specific_time() {
        assert!(cron_matches("30 14 * * *", dt(14, 30)));
        assert!(!cron_matches("30 14 * * *", dt(14, 31)));
        assert!(!cron_matches("30 14 * * *", dt(15, 30)));
    }

    #[test]
    fn test_wildcard_all() {
        assert!(cron_matches("* * * * *", dt(0, 0)));
        assert!(cron_matches("* * * * *", dt(23, 59)));
    }

    #[test]
    fn test_invalid_expr() {
        assert!(!cron_matches("", dt(0, 0)));
        assert!(!cron_matches("0 *", dt(0, 0)));
    }

    #[test]
    fn test_step_every_minute() {
        // */1 等价于每分钟
        assert!(cron_matches("*/1 * * * *", dt(3, 0)));
        assert!(cron_matches("*/1 * * * *", dt(3, 7)));
        assert!(cron_matches("*/1 * * * *", dt(23, 59)));
    }

    #[test]
    fn test_step_every_5_minutes() {
        assert!(cron_matches("*/5 * * * *", dt(1, 0)));
        assert!(cron_matches("*/5 * * * *", dt(1, 5)));
        assert!(cron_matches("*/5 * * * *", dt(1, 55)));
        assert!(!cron_matches("*/5 * * * *", dt(1, 7)));
        assert!(!cron_matches("*/5 * * * *", dt(1, 1)));
    }

    #[test]
    fn test_range_and_list() {
        // 分钟范围 10-12
        assert!(cron_matches("10-12 * * * *", dt(0, 10)));
        assert!(cron_matches("10-12 * * * *", dt(0, 12)));
        assert!(!cron_matches("10-12 * * * *", dt(0, 13)));
        // 逗号列表
        assert!(cron_matches("0,15,30,45 * * * *", dt(0, 15)));
        assert!(cron_matches("0,15,30,45 * * * *", dt(0, 45)));
        assert!(!cron_matches("0,15,30,45 * * * *", dt(0, 20)));
    }

    #[test]
    fn test_range_with_step() {
        // 1-10 内每 3 分钟：1,4,7,10
        assert!(cron_matches("1-10/3 * * * *", dt(0, 1)));
        assert!(cron_matches("1-10/3 * * * *", dt(0, 4)));
        assert!(cron_matches("1-10/3 * * * *", dt(0, 10)));
        assert!(!cron_matches("1-10/3 * * * *", dt(0, 2)));
        assert!(!cron_matches("1-10/3 * * * *", dt(0, 13)));
    }

    #[test]
    fn test_weekday_seven_is_sunday() {
        // 2026-06-09 是周二；用 7 表示周日不应匹配周二
        assert!(!cron_matches("* * * * 7", dt(0, 0)));
        // 2026-06-14 是周日
        let sunday = chrono::Utc.with_ymd_and_hms(2026, 6, 14, 0, 0, 0).unwrap();
        assert!(cron_matches("* * * * 7", sunday));
        assert!(cron_matches("* * * * 0", sunday));
    }

    #[test]
    fn test_hour_step_business_range() {
        // 工作时间每 2 小时（北京时间）：9-17/2 -> 9,11,13,15,17
        assert!(cron_matches("0 9-17/2 * * *", dt(9, 0)));
        assert!(cron_matches("0 9-17/2 * * *", dt(11, 0)));
        assert!(cron_matches("0 9-17/2 * * *", dt(17, 0)));
        assert!(!cron_matches("0 9-17/2 * * *", dt(10, 0)));
        assert!(!cron_matches("0 9-17/2 * * *", dt(9, 30)));
    }

    #[test]
    fn test_timezone_is_beijing() {
        // 北京时间 09:00（= UTC 01:00）应命中 "0 9 * * *"。
        let utc_0100 = chrono::Utc.with_ymd_and_hms(2026, 6, 9, 1, 0, 0).unwrap();
        assert!(cron_matches("0 9 * * *", utc_0100));
        // 而按 UTC 小时(1) 的表达式不应命中
        assert!(!cron_matches("0 1 * * *", utc_0100));
    }

    #[test]
    fn test_dom_dow_or_semantics() {
        // 2026-06-09 是周二（num_days_from_sunday = 2），日 = 9。
        // 日与周都被限定 → 取“或”
        assert!(cron_matches("* * 9 * 5", dt(0, 0))); // 日9命中 → true
        assert!(cron_matches("* * 1 * 2", dt(0, 0))); // 周二命中 → true
        assert!(!cron_matches("* * 1 * 5", dt(0, 0))); // 都不命中 → false
        // 有一个是 * → 取“与”
        assert!(cron_matches("* * 9 * *", dt(0, 0)));
        assert!(!cron_matches("* * 1 * *", dt(0, 0)));
    }

    #[test]
    fn test_validate_cron() {
        assert!(validate_cron("*/5 * * * *").is_ok());
        assert!(validate_cron("0 9-17/2 * * 1-5").is_ok());
        assert!(validate_cron("0 0 13 * 5").is_ok());
        assert!(validate_cron("* * * * 7").is_ok()); // 周日=7 合法
        assert!(validate_cron("60 * * * *").is_err()); // 分钟越界
        assert!(validate_cron("* * * 13 *").is_err()); // 月越界
        assert!(validate_cron("* * * * 8").is_err()); // 周越界
        assert!(validate_cron("* * * *").is_err()); // 字段数不对
        assert!(validate_cron("*/0 * * * *").is_err()); // 步进 0
        assert!(validate_cron("5-1 * * * *").is_err()); // 范围反向
    }
}
