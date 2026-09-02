// ! 代理商分销系统 - API Handlers
//!
//! 包含超管 API 和代理商 API 的所有处理函数。

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use sqlx::{types::{Decimal, Uuid}, PgPool};

use crate::auth::Claims;
use crate::crypto;
use crate::error::{AppError, Result};
use crate::middleware::PartnerContext;
use crate::partner_models::*;
use crate::permissions::require_platform_superadmin;
use onebase::license::{sign_license, LicenseClaims};

// ═══════════════════════════════════════════════════════════
// 超管 API - 代理商管理
// ═══════════════════════════════════════════════════════════

/// 创建代理商（超管）
pub async fn admin_create_partner(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreatePartnerRequest>,
) -> Result<impl IntoResponse> {
    require_platform_superadmin(&claims)?;

    // 验证 slug 唯一性
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM management.partners WHERE slug = $1)"
    )
    .bind(&req.slug)
    .fetch_one(&pool)
    .await?;

    if exists {
        return Err(AppError::InvalidQuery(format!(
            "代理商 slug '{}' 已存在",
            req.slug
        )));
    }

    // 验证佣金比例
    if req.commission_rate < Decimal::ZERO || req.commission_rate > Decimal::new(10000, 2) {
        return Err(AppError::InvalidQuery(
            "佣金比例必须在 0-100 之间".to_string(),
        ));
    }

    // 创建代理商
    let partner: Partner = sqlx::query_as(
        r#"
        INSERT INTO management.partners (
            name, company_name, slug, contact_email, contact_phone,
            commission_rate, payment_terms, license_quota, quota_expires_at,
            allowed_editions, allowed_modules, max_license_days
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
        "#,
    )
    .bind(&req.name)
    .bind(&req.company_name)
    .bind(&req.slug)
    .bind(&req.contact_email)
    .bind(&req.contact_phone)
    .bind(req.commission_rate)
    .bind(req.payment_terms)
    .bind(req.license_quota)
    .bind(req.quota_expires_at)
    .bind(serde_json::to_value(&req.allowed_editions)?)
    .bind(serde_json::to_value(&req.allowed_modules)?)
    .bind(req.max_license_days)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({
        "partner": partner,
        "message": "代理商创建成功"
    })))
}

/// 查询代理商列表（超管）
#[derive(Debug, Deserialize)]
pub struct ListPartnersQuery {
    pub status: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

pub async fn admin_list_partners(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(query): Query<ListPartnersQuery>,
) -> Result<impl IntoResponse> {
    require_platform_superadmin(&claims)?;

    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(20).min(100);
    let offset = (page - 1) * page_size;

    let mut sql = String::from("SELECT * FROM management.v_partner_stats WHERE 1=1");
    if let Some(status) = &query.status {
        sql.push_str(&format!(" AND status = '{}'", status));
    }
    sql.push_str(" ORDER BY created_at DESC");
    sql.push_str(&format!(" LIMIT {} OFFSET {}", page_size, offset));

    let partners: Vec<PartnerStats> = sqlx::query_as(&sql).fetch_all(&pool).await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM management.partners WHERE status = COALESCE($1, status)",
    )
    .bind(&query.status)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({
        "partners": partners,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": (total + page_size - 1) / page_size
        }
    })))
}

/// 更新代理商信息（超管）
pub async fn admin_update_partner(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
    Json(req): Json<UpdatePartnerRequest>,
) -> Result<impl IntoResponse> {
    require_platform_superadmin(&claims)?;

    // 验证代理商存在
    let partner: Partner = sqlx::query_as("SELECT * FROM management.partners WHERE id = $1")
        .bind(id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound("代理商不存在".to_string()))?;

    // 构建动态更新 SQL
    let mut updates = Vec::new();
    let mut params: Vec<String> = Vec::new();
    let mut param_idx = 1;

    if let Some(name) = &req.name {
        updates.push(format!("name = ${}", param_idx));
        params.push(name.clone());
        param_idx += 1;
    }
    if let Some(company_name) = &req.company_name {
        updates.push(format!("company_name = ${}", param_idx));
        params.push(company_name.clone());
        param_idx += 1;
    }
    if let Some(contact_email) = &req.contact_email {
        updates.push(format!("contact_email = ${}", param_idx));
        params.push(contact_email.clone());
        param_idx += 1;
    }
    if let Some(status) = &req.status {
        updates.push(format!("status = ${}", param_idx));
        params.push(status.clone());
        param_idx += 1;
    }
    if let Some(commission_rate) = req.commission_rate {
        updates.push(format!("commission_rate = ${}", param_idx));
        params.push(commission_rate.to_string());
        param_idx += 1;
    }
    if let Some(license_quota) = req.license_quota {
        updates.push(format!("license_quota = ${}", param_idx));
        params.push(license_quota.to_string());
        param_idx += 1;
    }

    if updates.is_empty() {
        return Ok(Json(json!({
            "partner": partner,
            "message": "无需更新"
        })));
    }

    // 简化：直接使用原有 partner 数据 + 更新字段重新 INSERT（实际应该用动态 SQL）
    let updated_partner: Partner = sqlx::query_as(
        r#"
        UPDATE management.partners
        SET name = COALESCE($2, name),
            company_name = COALESCE($3, company_name),
            contact_email = COALESCE($4, contact_email),
            contact_phone = COALESCE($5, contact_phone),
            status = COALESCE($6, status),
            commission_rate = COALESCE($7, commission_rate),
            payment_terms = COALESCE($8, payment_terms),
            license_quota = COALESCE($9, license_quota),
            quota_expires_at = COALESCE($10, quota_expires_at),
            allowed_editions = COALESCE($11, allowed_editions),
            allowed_modules = COALESCE($12, allowed_modules),
            max_license_days = COALESCE($13, max_license_days)
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(req.name)
    .bind(req.company_name)
    .bind(req.contact_email)
    .bind(req.contact_phone)
    .bind(req.status)
    .bind(req.commission_rate)
    .bind(req.payment_terms)
    .bind(req.license_quota)
    .bind(req.quota_expires_at)
    .bind(req.allowed_editions.map(|v| serde_json::to_value(v).unwrap()))
    .bind(req.allowed_modules.map(|v| serde_json::to_value(v).unwrap()))
    .bind(req.max_license_days)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({
        "partner": updated_partner,
        "message": "代理商信息更新成功"
    })))
}

/// 挂起/停用代理商（超管）
pub async fn admin_suspend_partner(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<impl IntoResponse> {
    require_platform_superadmin(&claims)?;

    let partner: Partner =
        sqlx::query_as("UPDATE management.partners SET status = 'suspended' WHERE id = $1 RETURNING *")
            .bind(id)
            .fetch_optional(&pool)
            .await?
            .ok_or_else(|| AppError::NotFound("代理商不存在".to_string()))?;

    Ok(Json(json!({
        "partner": partner,
        "message": "代理商已挂起"
    })))
}

/// 获取代理商详细统计（超管）
pub async fn admin_partner_statistics(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<impl IntoResponse> {
    require_platform_superadmin(&claims)?;

    let partner: Partner = sqlx::query_as("SELECT * FROM management.partners WHERE id = $1")
        .bind(id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound("代理商不存在".to_string()))?;

    let stats: PartnerStats =
        sqlx::query_as("SELECT * FROM management.v_partner_stats WHERE partner_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await?;

    Ok(Json(PartnerStatsResponse { partner, stats }))
}

/// 手动生成对账单（超管）
pub async fn admin_generate_statement(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<GenerateStatementRequest>,
) -> Result<impl IntoResponse> {
    require_platform_superadmin(&claims)?;

    // 验证代理商存在
    let partner: Partner = sqlx::query_as("SELECT * FROM management.partners WHERE id = $1")
        .bind(req.partner_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound("代理商不存在".to_string()))?;

    // 统计周期内的 License 佣金（新签）
    #[derive(sqlx::FromRow)]
    struct CommissionStats {
        total_licenses: Option<i64>,
        total_revenue: Option<Decimal>,
        total_commission: Option<Decimal>,
    }

    let license_stats: CommissionStats = sqlx::query_as(
        r#"
        SELECT
            COUNT(DISTINCT cl.id) AS total_licenses,
            COALESCE(SUM(cl.price), 0) AS total_revenue,
            COALESCE(SUM(pc.commission_amount), 0) AS total_commission
        FROM management.customer_licenses cl
        LEFT JOIN management.partner_commissions pc ON pc.license_id = cl.id AND pc.commission_type = 'license'
        WHERE cl.partner_id = $1
          AND cl.issued_at >= $2
          AND cl.issued_at < $3
        "#,
    )
    .bind(req.partner_id)
    .bind(req.period_start)
    .bind(req.period_end)
    .fetch_one(&pool)
    .await?;

    // 统计周期内的维护费佣金
    let maintenance_stats: CommissionStats = sqlx::query_as(
        r#"
        SELECT
            COUNT(DISTINCT mr.id) AS total_licenses,
            COALESCE(SUM(mr.maintenance_price), 0) AS total_revenue,
            COALESCE(SUM(pc.commission_amount), 0) AS total_commission
        FROM management.maintenance_renewals mr
        LEFT JOIN management.partner_commissions pc ON pc.related_license_id = mr.license_id AND pc.commission_type = 'maintenance'
        WHERE mr.partner_id = $1
          AND mr.period_start >= $2
          AND mr.period_start < $3
        "#,
    )
    .bind(req.partner_id)
    .bind(req.period_start)
    .bind(req.period_end)
    .fetch_one(&pool)
    .await?;

    // 创建对账单（区分 License 和维护费）
    let statement: PartnerStatement = sqlx::query_as(
        r#"
        INSERT INTO management.partner_statements (
            partner_id, period_start, period_end,
            total_licenses, total_revenue, total_commission,
            maintenance_count, total_maintenance_revenue, total_maintenance_commission,
            currency, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CNY', 'pending')
        RETURNING *
        "#,
    )
    .bind(req.partner_id)
    .bind(req.period_start)
    .bind(req.period_end)
    .bind(license_stats.total_licenses.unwrap_or(0) as i32)
    .bind(license_stats.total_revenue.unwrap_or(Decimal::ZERO))
    .bind(license_stats.total_commission.unwrap_or(Decimal::ZERO))
    .bind(maintenance_stats.total_licenses.unwrap_or(0) as i32)
    .bind(maintenance_stats.total_revenue.unwrap_or(Decimal::ZERO))
    .bind(maintenance_stats.total_commission.unwrap_or(Decimal::ZERO))
    .fetch_one(&pool)
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
    .bind(statement.id)
    .bind(req.partner_id)
    .bind(req.period_start)
    .bind(req.period_end)
    .execute(&pool)
    .await?;

    Ok(Json(json!({
        "statement": statement,
        "message": "对账单生成成功"
    })))
}

/// 标记对账单已支付（超管）
pub async fn admin_mark_statement_paid(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
    Json(req): Json<MarkStatementPaidRequest>,
) -> Result<impl IntoResponse> {
    require_platform_superadmin(&claims)?;

    let statement: PartnerStatement = sqlx::query_as(
        r#"
        UPDATE management.partner_statements
        SET status = 'paid', paid_at = NOW(), payment_reference = $2
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(req.payment_reference)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound("对账单不存在".to_string()))?;

    // 更新关联的佣金记录为已支付
    sqlx::query(
        "UPDATE management.partner_commissions SET status = 'paid' WHERE statement_id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await?;

    Ok(Json(json!({
        "statement": statement,
        "message": "对账单已标记支付"
    })))
}

// ═══════════════════════════════════════════════════════════
// 代理商 API - License 管理
// ═══════════════════════════════════════════════════════════

/// 获取代理商配置（代理商）
pub async fn partner_get_profile(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<PartnerContext>,
) -> Result<impl IntoResponse> {
    let partner: Partner = sqlx::query_as("SELECT * FROM management.partners WHERE id = $1")
        .bind(ctx.partner_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound("代理商不存在".to_string()))?;

    let available_quota = partner.license_quota - partner.used_quota;
    let quota_usage_percent = if partner.license_quota > 0 {
        Decimal::new(partner.used_quota as i64 * 10000, 2) / Decimal::new(partner.license_quota as i64, 0)
    } else {
        Decimal::ZERO
    };

    Ok(Json(PartnerProfile {
        partner,
        available_quota,
        quota_usage_percent,
    }))
}

/// 查询客户 License 列表（代理商）
#[derive(Debug, Deserialize)]
pub struct ListCustomersQuery {
    pub status: Option<String>,
    pub customer_name: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

pub async fn partner_list_customers(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<PartnerContext>,
    Query(query): Query<ListCustomersQuery>,
) -> Result<impl IntoResponse> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(20).min(100);
    let offset = (page - 1) * page_size;

    let mut sql = String::from("SELECT * FROM management.customer_licenses WHERE partner_id = $1");
    let mut param_count = 2;

    if query.status.is_some() {
        sql.push_str(&format!(" AND status = ${}", param_count));
        param_count += 1;
    }
    if query.customer_name.is_some() {
        sql.push_str(&format!(" AND customer_name ILIKE ${}", param_count));
        param_count += 1;
    }

    sql.push_str(" ORDER BY created_at DESC");
    sql.push_str(&format!(" LIMIT ${} OFFSET ${}", param_count, param_count + 1));

    let mut query_builder = sqlx::query_as::<_, CustomerLicense>(&sql).bind(ctx.partner_id);

    if let Some(status) = &query.status {
        query_builder = query_builder.bind(status);
    }
    if let Some(name) = &query.customer_name {
        query_builder = query_builder.bind(format!("%{}%", name));
    }

    query_builder = query_builder.bind(page_size).bind(offset);

    let licenses = query_builder.fetch_all(&pool).await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM management.customer_licenses WHERE partner_id = $1",
    )
    .bind(ctx.partner_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({
        "licenses": licenses,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": (total + page_size - 1) / page_size
        }
    })))
}

/// 签发 License（代理商）
pub async fn partner_issue_license(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<PartnerContext>,
    Json(req): Json<IssueLicenseRequest>,
) -> Result<impl IntoResponse> {
    // 1. 获取代理商信息并检查状态
    let partner: Partner = sqlx::query_as("SELECT * FROM management.partners WHERE id = $1")
        .bind(ctx.partner_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound("代理商不存在".to_string()))?;

    if partner.status != "active" {
        return Err(AppError::Forbidden(format!(
            "代理商状态为 '{}'，无法签发 License",
            partner.status
        )));
    }

    // 2. 检查配额
    if !partner.has_quota(1) {
        return Err(AppError::Forbidden(format!(
            "配额不足（已用 {}/{}）",
            partner.used_quota, partner.license_quota
        )));
    }

    if partner.is_quota_expired() {
        return Err(AppError::Forbidden("配额已过期".to_string()));
    }

    // 3. 验证授权范围
    if !partner.is_edition_allowed(&req.edition) {
        return Err(AppError::Forbidden(format!(
            "版本 '{}' 不在授权范围内",
            req.edition
        )));
    }

    if !partner.are_modules_allowed(&req.modules) {
        return Err(AppError::Forbidden("部分模块不在授权范围内".to_string()));
    }

    if !partner.is_days_allowed(req.days) {
        return Err(AppError::Forbidden(format!(
            "签发天数 {} 超过限制（最大 {} 天）",
            req.days,
            partner.max_license_days.unwrap_or(i32::MAX)
        )));
    }

    // 4. 生成 License
    let license_id = Uuid::new_v4();
    let now = Utc::now();
    let expires_at = now + chrono::Duration::days(req.days as i64);

    let claims = LicenseClaims {
        license_id: license_id.to_string(),
        customer: req.customer_name.clone(),
        edition: req.edition.clone(),
        modules: req.modules.clone(),
        max_nodes: Some(req.max_nodes as u32),
        max_tenants: Some(req.max_tenants as u32),
        max_accounts_per_tenant: req.max_accounts_per_tenant.map(|v| v as u32),
        issued_at: now.timestamp(),
        expires_at: expires_at.timestamp(),
        grace_days: req.grace_days as i64,
        fingerprint: req.fingerprint.clone(),
        notes: None,
    };

    // 从环境变量读取私钥
    let private_key = std::env::var("ONEBASE_LICENSE_PRIVATE_KEY")
        .map_err(|_| AppError::Internal("未配置 ONEBASE_LICENSE_PRIVATE_KEY".to_string()))?;

    let license_file_str = sign_license(&private_key, &claims)
        .map_err(|e| AppError::Internal(format!("签发 License 失败: {}", e)))?;

    let license_file_json: serde_json::Value = serde_json::from_str(&license_file_str)
        .map_err(|e| AppError::Internal(format!("License 文件解析失败: {}", e)))?;

    // 5. 加密指纹（可选）
    let fingerprint_encrypted = if let Some(fp) = &req.fingerprint {
        Some(crypto::encrypt_secret(fp)?)
    } else {
        None
    };

    // 6. 计算 License 佣金
    let commission_amount = req.price * partner.commission_rate / Decimal::new(10000, 2);

    // 7. 计算维护费（如果包含）
    let maintenance_price = if req.include_maintenance {
        Some(
            req.maintenance_price_override
                .unwrap_or_else(|| req.price * Decimal::new(20, 2)), // 默认 20%
        )
    } else {
        None
    };

    let maintenance_expires_at = if req.include_maintenance {
        Some(expires_at + chrono::Duration::days(365 * req.maintenance_years as i64))
    } else {
        None
    };

    let maintenance_commission_total = if let Some(price) = maintenance_price {
        Some(price * Decimal::new(req.maintenance_years as i64, 0) * req.maintenance_commission_rate / Decimal::new(10000, 2))
    } else {
        None
    };

    // 8. 数据库事务：插入 License + 更新配额 + 插入佣金 + 维护费记录
    let mut tx = pool.begin().await?;

    let customer_license: CustomerLicense = sqlx::query_as(
        r#"
        INSERT INTO management.customer_licenses (
            partner_id, license_id, customer_name, customer_company, customer_email, customer_contact_phone,
            edition, modules, max_nodes, max_tenants, max_accounts_per_tenant, fingerprint_encrypted,
            issued_at, expires_at, grace_days,
            license_type, price, currency,
            license_file_content, status,
            has_maintenance, maintenance_expires_at, maintenance_price, maintenance_commission_rate, auto_renew_maintenance
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'active', $20, $21, $22, $23, $24)
        RETURNING *
        "#,
    )
    .bind(ctx.partner_id)
    .bind(license_id)
    .bind(&req.customer_name)
    .bind(&req.customer_company)
    .bind(&req.customer_email)
    .bind(&req.customer_contact_phone)
    .bind(&req.edition)
    .bind(serde_json::to_value(&req.modules)?)
    .bind(req.max_nodes)
    .bind(req.max_tenants)
    .bind(req.max_accounts_per_tenant)
    .bind(&fingerprint_encrypted)
    .bind(now)
    .bind(expires_at)
    .bind(req.grace_days)
    .bind(&req.license_type)
    .bind(req.price)
    .bind(&req.currency)
    .bind(&license_file_json)
    .bind(req.include_maintenance)
    .bind(maintenance_expires_at)
    .bind(maintenance_price)
    .bind(req.maintenance_commission_rate)
    .bind(req.auto_renew_maintenance)
    .fetch_one(&mut *tx)
    .await?;

    // 9. 更新配额
    sqlx::query("UPDATE management.partners SET used_quota = used_quota + 1 WHERE id = $1")
        .bind(ctx.partner_id)
        .execute(&mut *tx)
        .await?;

    // 10. 插入 License 佣金记录（新签，commission_type = 'license'）
    sqlx::query(
        r#"
        INSERT INTO management.partner_commissions (
            partner_id, license_id, base_price, commission_rate, commission_amount, currency, status,
            commission_type, renewal_year, related_license_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'license', 0, $7)
        "#,
    )
    .bind(ctx.partner_id)
    .bind(customer_license.id)
    .bind(req.price)
    .bind(partner.commission_rate)
    .bind(commission_amount)
    .bind(&req.currency)
    .bind(license_id)
    .execute(&mut *tx)
    .await?;

    // 11. 如果包含维护费，创建维护费续费记录和佣金
    if req.include_maintenance && maintenance_price.is_some() {
        let maint_price = maintenance_price.unwrap();

        // 为每年创建 maintenance_renewals 记录
        for year in 1..=req.maintenance_years {
            let period_start = expires_at + chrono::Duration::days(365 * (year - 1) as i64);
            let period_end = expires_at + chrono::Duration::days(365 * year as i64);
            let year_commission = maint_price * req.maintenance_commission_rate / Decimal::new(10000, 2);

            sqlx::query(
                r#"
                INSERT INTO management.maintenance_renewals (
                    license_id, partner_id, renewal_year,
                    period_start, period_end,
                    maintenance_price, commission_rate, commission_amount, currency,
                    payment_status
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
                "#,
            )
            .bind(license_id)
            .bind(ctx.partner_id)
            .bind(year)
            .bind(period_start)
            .bind(period_end)
            .bind(maint_price)
            .bind(req.maintenance_commission_rate)
            .bind(year_commission)
            .bind(&req.currency)
            .execute(&mut *tx)
            .await?;

            // 创建维护费佣金记录
            sqlx::query(
                r#"
                INSERT INTO management.partner_commissions (
                    partner_id, license_id, base_price, commission_rate, commission_amount, currency, status,
                    commission_type, renewal_year, related_license_id
                )
                VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'maintenance', $7, $8)
                "#,
            )
            .bind(ctx.partner_id)
            .bind(customer_license.id)
            .bind(maint_price)
            .bind(req.maintenance_commission_rate)
            .bind(year_commission)
            .bind(&req.currency)
            .bind(year)
            .bind(license_id)
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;

    Ok(Json(IssueLicenseResponse {
        license_id,
        customer_license_id: customer_license.id,
        license_file: license_file_json,
        expires_at,
        commission_amount,
        has_maintenance: req.include_maintenance,
        maintenance_expires_at,
        maintenance_price,
        maintenance_commission: maintenance_commission_total,
    }))
}

/// 续费 License（代理商）
pub async fn partner_renew_license(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<PartnerContext>,
    Path(license_id): Path<i32>,
    Json(req): Json<RenewLicenseRequest>,
) -> Result<impl IntoResponse> {
    // 1. 查询原 License
    let old_license: CustomerLicense = sqlx::query_as(
        "SELECT * FROM management.customer_licenses WHERE id = $1 AND partner_id = $2",
    )
    .bind(license_id)
    .bind(ctx.partner_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound("License 不存在".to_string()))?;

    // 2. 检查代理商配额
    let partner: Partner = sqlx::query_as("SELECT * FROM management.partners WHERE id = $1")
        .bind(ctx.partner_id)
        .fetch_one(&pool)
        .await?;

    if !partner.has_quota(1) {
        return Err(AppError::Forbidden("配额不足".to_string()));
    }

    // 3. 生成新 License（复制配置，更新时间）
    let new_license_id = Uuid::new_v4();
    let now = Utc::now();
    let new_expires_at = now + chrono::Duration::days(req.days as i64);

    let modules: Vec<String> = serde_json::from_value(old_license.modules.clone())
        .unwrap_or_default();

    let claims = LicenseClaims {
        license_id: new_license_id.to_string(),
        customer: old_license.customer_name.clone(),
        edition: old_license.edition.clone(),
        modules,
        max_nodes: Some(old_license.max_nodes as u32),
        max_tenants: Some(old_license.max_tenants as u32),
        max_accounts_per_tenant: old_license.max_accounts_per_tenant.map(|v| v as u32),
        issued_at: now.timestamp(),
        expires_at: new_expires_at.timestamp(),
        grace_days: old_license.grace_days as i64,
        fingerprint: old_license.fingerprint_encrypted.as_ref().and_then(|enc| {
            crypto::decrypt_secret(enc).ok()
        }),
        notes: None,
    };

    let private_key = std::env::var("ONEBASE_LICENSE_PRIVATE_KEY")
        .map_err(|_| AppError::Internal("未配置 ONEBASE_LICENSE_PRIVATE_KEY".to_string()))?;

    let license_file_str = sign_license(&private_key, &claims)
        .map_err(|e| AppError::Internal(format!("签发 License 失败: {}", e)))?;

    let license_file_json: serde_json::Value = serde_json::from_str(&license_file_str)?;

    // 4. 计算佣金
    let commission_amount = req.price * partner.commission_rate / Decimal::new(10000, 2);

    // 4.5 继承维护费配置
    let (has_maintenance, maintenance_expires_at, maintenance_price, maintenance_commission_rate) =
        if old_license.has_maintenance {
            let new_maint_expires = new_expires_at
                + (old_license.maintenance_expires_at.unwrap_or(old_license.expires_at)
                    - old_license.expires_at);
            (
                true,
                Some(new_maint_expires),
                old_license.maintenance_price,
                old_license.maintenance_commission_rate,
            )
        } else {
            (false, None, None, None)
        };

    // 5. 事务：插入新 License + 更新旧 License + 更新配额 + 插入佣金
    let mut tx = pool.begin().await?;

    let new_license: CustomerLicense = sqlx::query_as(
        r#"
        INSERT INTO management.customer_licenses (
            partner_id, license_id, customer_name, customer_company, customer_email, customer_contact_phone,
            edition, modules, max_nodes, max_tenants, max_accounts_per_tenant, fingerprint_encrypted,
            issued_at, expires_at, grace_days,
            license_type, price, currency,
            license_file_content, status, parent_license_id,
            has_maintenance, maintenance_expires_at, maintenance_price, maintenance_commission_rate, auto_renew_maintenance
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'active', $20, $21, $22, $23, $24, $25)
        RETURNING *
        "#,
    )
    .bind(ctx.partner_id)
    .bind(new_license_id)
    .bind(&old_license.customer_name)
    .bind(&old_license.customer_company)
    .bind(&old_license.customer_email)
    .bind(&old_license.customer_contact_phone)
    .bind(&old_license.edition)
    .bind(&old_license.modules)
    .bind(old_license.max_nodes)
    .bind(old_license.max_tenants)
    .bind(old_license.max_accounts_per_tenant)
    .bind(&old_license.fingerprint_encrypted)
    .bind(now)
    .bind(new_expires_at)
    .bind(old_license.grace_days)
    .bind(&old_license.license_type)
    .bind(req.price)
    .bind(&req.currency)
    .bind(&license_file_json)
    .bind(license_id)
    .bind(has_maintenance)
    .bind(maintenance_expires_at)
    .bind(maintenance_price)
    .bind(maintenance_commission_rate)
    .bind(old_license.auto_renew_maintenance)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE management.customer_licenses SET renewed_to_license_id = $1 WHERE id = $2",
    )
    .bind(new_license.id)
    .bind(license_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE management.partners SET used_quota = used_quota + 1 WHERE id = $1")
        .bind(ctx.partner_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO management.partner_commissions (
            partner_id, license_id, base_price, commission_rate, commission_amount, currency, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'pending')
        "#,
    )
    .bind(ctx.partner_id)
    .bind(new_license.id)
    .bind(req.price)
    .bind(partner.commission_rate)
    .bind(commission_amount)
    .bind(&req.currency)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(IssueLicenseResponse {
        license_id: new_license_id,
        customer_license_id: new_license.id,
        license_file: license_file_json,
        expires_at: new_expires_at,
        commission_amount,
        has_maintenance: new_license.has_maintenance,
        maintenance_expires_at: new_license.maintenance_expires_at,
        maintenance_price: new_license.maintenance_price,
        maintenance_commission: None, // 续费不重新生成维护费佣金，继承原配置
    }))
}

/// 查询佣金记录（代理商）
pub async fn partner_list_commissions(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<PartnerContext>,
    Query(query): Query<ListCustomersQuery>,
) -> Result<impl IntoResponse> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(20).min(100);
    let offset = (page - 1) * page_size;

    let commissions: Vec<PartnerCommission> = sqlx::query_as(
        r#"
        SELECT * FROM management.partner_commissions
        WHERE partner_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(ctx.partner_id)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&pool)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM management.partner_commissions WHERE partner_id = $1",
    )
    .bind(ctx.partner_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({
        "commissions": commissions,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": (total + page_size - 1) / page_size
        }
    })))
}

/// 查询对账单（代理商）
pub async fn partner_list_statements(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<PartnerContext>,
    Query(query): Query<ListCustomersQuery>,
) -> Result<impl IntoResponse> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(20).min(100);
    let offset = (page - 1) * page_size;

    let statements: Vec<PartnerStatement> = sqlx::query_as(
        r#"
        SELECT * FROM management.partner_statements
        WHERE partner_id = $1
        ORDER BY period_start DESC
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(ctx.partner_id)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&pool)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM management.partner_statements WHERE partner_id = $1",
    )
    .bind(ctx.partner_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({
        "statements": statements,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": (total + page_size - 1) / page_size
        }
    })))
}

// ═══════════════════════════════════════════════════════════
// 代理商 API - 维护费管理
// ═══════════════════════════════════════════════════════════

/// 查询维护费续费记录（代理商）
#[derive(Debug, Deserialize)]
pub struct ListMaintenanceRenewalsQuery {
    pub payment_status: Option<String>,
    pub expiring_soon: Option<bool>, // 30 天内到期
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

pub async fn partner_list_maintenance_renewals(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<PartnerContext>,
    Query(query): Query<ListMaintenanceRenewalsQuery>,
) -> Result<impl IntoResponse> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(20).min(100);
    let offset = (page - 1) * page_size;

    let mut sql = String::from(
        r#"
        SELECT mr.*, cl.customer_name, cl.customer_company, cl.edition
        FROM management.maintenance_renewals mr
        JOIN management.customer_licenses cl ON mr.license_id = cl.license_id
        WHERE mr.partner_id = $1
        "#,
    );
    let mut param_count = 2;

    if let Some(status) = &query.payment_status {
        sql.push_str(&format!(" AND mr.payment_status = ${}", param_count));
        param_count += 1;
    }

    if query.expiring_soon.unwrap_or(false) {
        sql.push_str(&format!(
            " AND mr.period_end BETWEEN NOW() AND NOW() + INTERVAL '30 days'"
        ));
    }

    sql.push_str(" ORDER BY mr.period_end ASC");
    sql.push_str(&format!(" LIMIT ${} OFFSET ${}", param_count, param_count + 1));

    #[derive(sqlx::FromRow, serde::Serialize)]
    struct MaintenanceRenewalWithCustomer {
        id: i32,
        license_id: Uuid,
        partner_id: i32,
        renewal_year: i32,
        period_start: DateTime<Utc>,
        period_end: DateTime<Utc>,
        maintenance_price: Decimal,
        commission_rate: Decimal,
        commission_amount: Decimal,
        currency: String,
        payment_status: String,
        paid_at: Option<DateTime<Utc>>,
        payment_reference: Option<String>,
        created_at: DateTime<Utc>,
        updated_at: DateTime<Utc>,
        customer_name: String,
        customer_company: Option<String>,
        edition: String,
    }

    let mut query_builder = sqlx::query_as::<_, MaintenanceRenewalWithCustomer>(&sql)
        .bind(ctx.partner_id);

    if let Some(status) = &query.payment_status {
        query_builder = query_builder.bind(status);
    }

    query_builder = query_builder.bind(page_size).bind(offset);

    let renewals = query_builder.fetch_all(&pool).await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM management.maintenance_renewals WHERE partner_id = $1",
    )
    .bind(ctx.partner_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({
        "renewals": renewals,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": (total + page_size - 1) / page_size
        }
    })))
}

/// 标记维护费已支付（代理商）
#[derive(Debug, Deserialize)]
pub struct MarkMaintenancePaidRequest {
    pub payment_reference: Option<String>,
}

pub async fn partner_mark_maintenance_paid(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<PartnerContext>,
    Path(renewal_id): Path<i32>,
    Json(req): Json<MarkMaintenancePaidRequest>,
) -> Result<impl IntoResponse> {
    // 验证续费记录归属
    let renewal: MaintenanceRenewal = sqlx::query_as(
        "SELECT * FROM management.maintenance_renewals WHERE id = $1 AND partner_id = $2",
    )
    .bind(renewal_id)
    .bind(ctx.partner_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound("维护费续费记录不存在".to_string()))?;

    if renewal.payment_status == "paid" {
        return Err(AppError::InvalidQuery("维护费已标记为支付状态".to_string()));
    }

    // 更新支付状态
    let updated_renewal: MaintenanceRenewal = sqlx::query_as(
        r#"
        UPDATE management.maintenance_renewals
        SET payment_status = 'paid', paid_at = NOW(), payment_reference = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *
        "#,
    )
    .bind(&req.payment_reference)
    .bind(renewal_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({
        "renewal": updated_renewal,
        "message": "维护费已标记为支付状态"
    })))
}

/// 获取即将到期的维护服务（代理商）
pub async fn partner_expiring_maintenance(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<PartnerContext>,
) -> Result<impl IntoResponse> {
    #[derive(sqlx::FromRow, serde::Serialize)]
    struct ExpiringMaintenance {
        license_id: Uuid,
        customer_name: String,
        customer_company: Option<String>,
        customer_email: Option<String>,
        edition: String,
        maintenance_expires_at: DateTime<Utc>,
        maintenance_price: Decimal,
        days_remaining: i32,
        auto_renew_maintenance: bool,
    }

    let expiring: Vec<ExpiringMaintenance> = sqlx::query_as(
        r#"
        SELECT
            license_id,
            customer_name,
            customer_company,
            customer_email,
            edition,
            maintenance_expires_at,
            maintenance_price,
            EXTRACT(DAY FROM (maintenance_expires_at - NOW()))::int AS days_remaining,
            auto_renew_maintenance
        FROM management.customer_licenses
        WHERE partner_id = $1
          AND has_maintenance = true
          AND maintenance_expires_at BETWEEN NOW() AND NOW() + INTERVAL '30 days'
        ORDER BY maintenance_expires_at ASC
        "#,
    )
    .bind(ctx.partner_id)
    .fetch_all(&pool)
    .await?;

    Ok(Json(json!({
        "expiring_maintenance": expiring,
        "count": expiring.len()
    })))
}
