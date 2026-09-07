//! 代理商分销系统 - 后台定时任务
//!
//! 包含：
//! - 每月自动生成对账单
//! - 每小时更新 License 状态（active → grace → expired）
//! - 每天维护费到期提醒
//! - 每天自动续费维护服务
//! - 每周逾期维护费处理

use chrono::{Datelike, Duration, Timelike, Utc};
use sqlx::{types::{Decimal, Uuid}, PgPool};
use tokio::time::interval;

/// 启动代理商后台任务
pub fn spawn_partner_tasks(pool: PgPool) {
    // 任务 1：每月 1 号凌晨生成对账单
    let pool_clone1 = pool.clone();
    tokio::spawn(async move {
        generate_monthly_statements_loop(pool_clone1).await;
    });

    // 任务 2：每小时更新 License 状态
    let pool_clone2 = pool.clone();
    tokio::spawn(async move {
        update_license_status_loop(pool_clone2).await;
    });

    // 任务 3：每天检查维护费到期提醒
    let pool_clone3 = pool.clone();
    tokio::spawn(async move {
        maintenance_expiration_reminder_loop(pool_clone3).await;
    });

    // 任务 4：每天检查自动续费维护
    let pool_clone4 = pool.clone();
    tokio::spawn(async move {
        auto_renew_maintenance_loop(pool_clone4).await;
    });

    // 任务 5：每周检查逾期维护费
    tokio::spawn(async move {
        handle_overdue_maintenance_loop(pool).await;
    });
}

/// 每月 1 号凌晨生成对账单（循环）
async fn generate_monthly_statements_loop(pool: PgPool) {
    let mut ticker = interval(std::time::Duration::from_secs(3600)); // 每小时检查一次

    loop {
        ticker.tick().await;

        let now = Utc::now();
        // 只在每月 1 号凌晨 0-1 点之间执行
        if now.day() == 1 && now.hour() == 0 {
            if let Err(e) = generate_monthly_statements(&pool).await {
                tracing::error!("生成月度对账单失败: {}", e);
            }
        }
    }
}

/// 生成上月的对账单
async fn generate_monthly_statements(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    let now = Utc::now();
    let period_end = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let period_start = (period_end - Duration::days(30))
        .date_naive()
        .with_day(1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();

    tracing::info!(
        "开始生成月度对账单：{} 至 {}",
        period_start,
        period_end
    );

    // 获取所有活跃代理商
    let partner_ids: Vec<i32> = sqlx::query_scalar(
        "SELECT id FROM management.partners WHERE status = 'active' ORDER BY id",
    )
    .fetch_all(pool)
    .await?;

    let mut success_count = 0;
    let mut error_count = 0;

    for partner_id in partner_ids {
        match generate_statement_for_partner(pool, partner_id, period_start, period_end).await {
            Ok(_) => {
                success_count += 1;
                tracing::info!("代理商 {} 对账单生成成功", partner_id);
            }
            Err(e) => {
                error_count += 1;
                tracing::error!("代理商 {} 对账单生成失败: {}", partner_id, e);
            }
        }
    }

    tracing::info!(
        "月度对账单生成完成：成功 {}，失败 {}",
        success_count,
        error_count
    );

    Ok(())
}

/// 为单个代理商生成对账单
async fn generate_statement_for_partner(
    pool: &PgPool,
    partner_id: i32,
    period_start: chrono::DateTime<Utc>,
    period_end: chrono::DateTime<Utc>,
) -> Result<(), Box<dyn std::error::Error>> {
    #[derive(sqlx::FromRow)]
    struct CommissionStats {
        total_licenses: Option<i64>,
        total_revenue: Option<Decimal>,
        total_commission: Option<Decimal>,
    }

    // 统计周期内的佣金
    let stats: CommissionStats = sqlx::query_as(
        r#"
        SELECT
            COUNT(DISTINCT cl.id) AS total_licenses,
            COALESCE(SUM(cl.price), 0) AS total_revenue,
            COALESCE(SUM(pc.commission_amount), 0) AS total_commission
        FROM management.customer_licenses cl
        LEFT JOIN management.partner_commissions pc ON pc.license_id = cl.id
        WHERE cl.partner_id = $1
          AND cl.issued_at >= $2
          AND cl.issued_at < $3
        "#,
    )
    .bind(partner_id)
    .bind(period_start)
    .bind(period_end)
    .fetch_one(pool)
    .await?;

    // 如果没有 License，跳过
    if stats.total_licenses.unwrap_or(0) == 0 {
        tracing::debug!("代理商 {} 本周期无 License，跳过对账单生成", partner_id);
        return Ok(());
    }

    // 检查是否已存在对账单
    let existing: Option<i32> = sqlx::query_scalar(
        r#"
        SELECT id FROM management.partner_statements
        WHERE partner_id = $1 AND period_start = $2 AND period_end = $3
        "#,
    )
    .bind(partner_id)
    .bind(period_start)
    .bind(period_end)
    .fetch_optional(pool)
    .await?;

    if existing.is_some() {
        tracing::debug!("代理商 {} 本周期对账单已存在，跳过", partner_id);
        return Ok(());
    }

    // 创建对账单
    let statement_id: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO management.partner_statements (
            partner_id, period_start, period_end,
            total_licenses, total_revenue, total_commission, currency, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'CNY', 'pending')
        RETURNING id
        "#,
    )
    .bind(partner_id)
    .bind(period_start)
    .bind(period_end)
    .bind(stats.total_licenses.unwrap_or(0) as i32)
    .bind(stats.total_revenue.unwrap_or(Decimal::ZERO))
    .bind(stats.total_commission.unwrap_or(Decimal::ZERO))
    .fetch_one(pool)
    .await?;

    // 更新佣金记录关联到对账单
    sqlx::query(
        r#"
        UPDATE management.partner_commissions pc
        SET statement_id = $1, status = 'approved'
        FROM management.customer_licenses cl
        WHERE pc.license_id = cl.id
          AND cl.partner_id = $2
          AND cl.issued_at >= $3
          AND cl.issued_at < $4
          AND pc.status = 'pending'
        "#,
    )
    .bind(statement_id)
    .bind(partner_id)
    .bind(period_start)
    .bind(period_end)
    .execute(pool)
    .await?;

    Ok(())
}

/// 每小时更新 License 状态（循环）
async fn update_license_status_loop(pool: PgPool) {
    let mut ticker = interval(std::time::Duration::from_secs(3600)); // 每小时

    loop {
        ticker.tick().await;

        if let Err(e) = update_expired_licenses(&pool).await {
            tracing::error!("更新 License 状态失败: {}", e);
        }
    }
}

/// 更新过期的 License 状态
async fn update_expired_licenses(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    let now = Utc::now();

    // 更新：active → grace（已过期但在宽限期内）
    let grace_count = sqlx::query(
        r#"
        UPDATE management.customer_licenses
        SET status = 'grace'
        WHERE status = 'active'
          AND expires_at < $1
          AND expires_at + (grace_days || ' days')::interval >= $1
        "#,
    )
    .bind(now)
    .execute(pool)
    .await?
    .rows_affected();

    if grace_count > 0 {
        tracing::info!("更新 {} 个 License 进入宽限期", grace_count);
    }

    // 更新：grace → expired（宽限期已满）
    let expired_count = sqlx::query(
        r#"
        UPDATE management.customer_licenses
        SET status = 'expired'
        WHERE status IN ('active', 'grace')
          AND expires_at + (grace_days || ' days')::interval < $1
        "#,
    )
    .bind(now)
    .execute(pool)
    .await?
    .rows_affected();

    if expired_count > 0 {
        tracing::info!("更新 {} 个 License 为已过期", expired_count);
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════
// 维护费相关定时任务
// ═══════════════════════════════════════════════════════════

/// 每天凌晨检查维护费到期提醒（循环）
async fn maintenance_expiration_reminder_loop(pool: PgPool) {
    let mut ticker = interval(std::time::Duration::from_secs(3600)); // 每小时检查

    loop {
        ticker.tick().await;

        let now = Utc::now();
        // 每天凌晨 1 点执行
        if now.hour() == 1 {
            if let Err(e) = send_expiration_reminders(&pool).await {
                tracing::error!("发送维护费到期提醒失败: {}", e);
            }
        }
    }
}

/// 发送维护费到期提醒
async fn send_expiration_reminders(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    #[derive(sqlx::FromRow)]
    struct ExpiringMaintenance {
        license_id: Uuid,
        partner_id: i32,
        customer_name: String,
        customer_email: Option<String>,
        maintenance_expires_at: chrono::DateTime<Utc>,
        maintenance_price: Decimal,
        days_remaining: i32,
    }

    // 查找 30 天内到期的维护服务
    let expiring: Vec<ExpiringMaintenance> = sqlx::query_as(
        r#"
        SELECT
            license_id,
            partner_id,
            customer_name,
            customer_email,
            maintenance_expires_at,
            maintenance_price,
            EXTRACT(DAY FROM (maintenance_expires_at - NOW()))::int AS days_remaining
        FROM management.customer_licenses
        WHERE has_maintenance = true
          AND auto_renew_maintenance = false
          AND maintenance_expires_at BETWEEN NOW() AND NOW() + INTERVAL '30 days'
        ORDER BY maintenance_expires_at ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    tracing::info!("发现 {} 个即将到期的维护服务", expiring.len());

    for record in expiring {
        // TODO: 实际发送邮件通知（集成邮件服务）
        tracing::info!(
            "维护费到期提醒：客户「{}」的维护服务将在 {} 天后到期（{}），价格 ¥{}",
            record.customer_name,
            record.days_remaining,
            record.maintenance_expires_at.format("%Y-%m-%d"),
            record.maintenance_price
        );
    }

    Ok(())
}

/// 每天凌晨检查自动续费维护（循环）
async fn auto_renew_maintenance_loop(pool: PgPool) {
    let mut ticker = interval(std::time::Duration::from_secs(3600)); // 每小时检查

    loop {
        ticker.tick().await;

        let now = Utc::now();
        // 每天凌晨 2 点执行
        if now.hour() == 2 {
            if let Err(e) = process_auto_renewals(&pool).await {
                tracing::error!("处理自动续费维护失败: {}", e);
            }
        }
    }
}

/// 自动续费 License 结构体
#[derive(sqlx::FromRow)]
struct AutoRenewLicense {
    id: i32,
    license_id: Uuid,
    partner_id: i32,
    customer_name: String,
    maintenance_expires_at: chrono::DateTime<Utc>,
    maintenance_price: Decimal,
    maintenance_commission_rate: Decimal,
}

/// 处理自动续费维护服务
async fn process_auto_renewals(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    // 查找 7 天内到期且启用自动续费的维护服务
    let auto_renew_licenses: Vec<AutoRenewLicense> = sqlx::query_as(
        r#"
        SELECT
            id, license_id, partner_id, customer_name,
            maintenance_expires_at, maintenance_price, maintenance_commission_rate
        FROM management.customer_licenses
        WHERE has_maintenance = true
          AND auto_renew_maintenance = true
          AND maintenance_expires_at BETWEEN NOW() + INTERVAL '6 days' AND NOW() + INTERVAL '8 days'
        "#,
    )
    .fetch_all(pool)
    .await?;

    tracing::info!("发现 {} 个需要自动续费的维护服务", auto_renew_licenses.len());

    for license in auto_renew_licenses {
        match create_maintenance_renewal(pool, &license).await {
            Ok(renewal_id) => {
                tracing::info!(
                    "自动续费成功：客户「{}」，续费记录 ID {}",
                    license.customer_name,
                    renewal_id
                );
            }
            Err(e) => {
                tracing::error!(
                    "自动续费失败：客户「{}」，错误: {}",
                    license.customer_name,
                    e
                );
            }
        }
    }

    Ok(())
}

/// 创建维护费续费记录
async fn create_maintenance_renewal(
    pool: &PgPool,
    license: &AutoRenewLicense,
) -> Result<i32, Box<dyn std::error::Error>> {
    // 获取当前的续费年份（查询最大 renewal_year）
    let max_year: Option<i32> = sqlx::query_scalar(
        "SELECT MAX(renewal_year) FROM management.maintenance_renewals WHERE license_id = $1",
    )
    .bind(license.license_id)
    .fetch_optional(pool)
    .await?
    .flatten();

    let next_year = max_year.unwrap_or(0) + 1;

    let period_start = license.maintenance_expires_at;
    let period_end = period_start + Duration::days(365);

    let commission_amount =
        license.maintenance_price * license.maintenance_commission_rate / Decimal::new(10000, 2);

    // 创建续费记录
    let renewal_id: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO management.maintenance_renewals (
            license_id, partner_id, renewal_year,
            period_start, period_end,
            maintenance_price, commission_rate, commission_amount, currency,
            payment_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CNY', 'pending')
        RETURNING id
        "#,
    )
    .bind(license.license_id)
    .bind(license.partner_id)
    .bind(next_year)
    .bind(period_start)
    .bind(period_end)
    .bind(license.maintenance_price)
    .bind(license.maintenance_commission_rate)
    .bind(commission_amount)
    .fetch_one(pool)
    .await?;

    // 创建佣金记录
    sqlx::query(
        r#"
        INSERT INTO management.partner_commissions (
            partner_id, license_id, base_price, commission_rate, commission_amount, currency, status,
            commission_type, renewal_year, related_license_id
        )
        VALUES ($1, $2, $3, $4, $5, 'CNY', 'pending', 'maintenance', $6, $7)
        "#,
    )
    .bind(license.partner_id)
    .bind(license.id)
    .bind(license.maintenance_price)
    .bind(license.maintenance_commission_rate)
    .bind(commission_amount)
    .bind(next_year)
    .bind(license.license_id)
    .execute(pool)
    .await?;

    // 延长维护到期时间
    sqlx::query(
        r#"
        UPDATE management.customer_licenses
        SET maintenance_expires_at = maintenance_expires_at + INTERVAL '1 year'
        WHERE id = $1
        "#,
    )
    .bind(license.id)
    .execute(pool)
    .await?;

    Ok(renewal_id)
}

/// 每周日凌晨检查逾期维护费（循环）
async fn handle_overdue_maintenance_loop(pool: PgPool) {
    let mut ticker = interval(std::time::Duration::from_secs(86400)); // 每天检查一次

    loop {
        ticker.tick().await;

        let now = Utc::now();
        // 只在周日凌晨 3 点执行
        if now.weekday() == chrono::Weekday::Sun && now.hour() == 3 {
            if let Err(e) = handle_overdue_maintenance(&pool).await {
                tracing::error!("处理逾期维护费失败: {}", e);
            }
        }
    }
}

/// 处理逾期维护费
async fn handle_overdue_maintenance(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    // 将 7 天前到期且未支付的维护费标记为逾期
    let overdue_count = sqlx::query(
        r#"
        UPDATE management.maintenance_renewals
        SET payment_status = 'overdue'
        WHERE payment_status = 'pending'
          AND period_end < NOW() - INTERVAL '7 days'
        "#,
    )
    .execute(pool)
    .await?
    .rows_affected();

    if overdue_count > 0 {
        tracing::warn!("标记 {} 条维护费续费记录为逾期状态", overdue_count);
    }

    Ok(())
}
