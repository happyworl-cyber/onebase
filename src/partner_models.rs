// ! 代理商分销系统 - 数据模型
//!
//! 定义代理商、License、佣金、对账单等核心数据结构及请求/响应模型。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{types::{Decimal, Uuid}, FromRow};

// ═══════════════════════════════════════════════════════════
// 数据库模型
// ═══════════════════════════════════════════════════════════

/// 代理商
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Partner {
    pub id: i32,
    pub name: String,
    pub company_name: String,
    pub slug: String,
    pub contact_email: String,
    pub contact_phone: Option<String>,
    pub status: String, // active | suspended | inactive

    // 佣金与配额
    pub commission_rate: Decimal,
    pub payment_terms: i32,
    pub license_quota: i32,
    pub used_quota: i32,
    pub quota_expires_at: Option<DateTime<Utc>>,

    // 授权范围
    pub allowed_editions: JsonValue,
    pub allowed_modules: JsonValue,
    pub max_license_days: Option<i32>,

    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 代理商用户关联
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PartnerUser {
    pub id: i32,
    pub partner_id: i32,
    pub user_id: i32,
    pub role: String, // admin | member
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
}

/// 客户 License 记录
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CustomerLicense {
    pub id: i32,
    pub partner_id: i32,
    pub license_id: Uuid,

    // 客户信息
    pub customer_name: String,
    pub customer_company: Option<String>,
    pub customer_email: Option<String>,
    pub customer_contact_phone: Option<String>,

    // License 配置
    pub edition: String,
    pub modules: JsonValue,
    pub max_nodes: i32,
    pub max_tenants: i32,
    pub max_accounts_per_tenant: Option<i32>,
    pub fingerprint_encrypted: Option<String>,

    // 时间配置
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub grace_days: i32,

    // License 类型与价格
    pub license_type: String, // subscription | perpetual
    pub price: Decimal,
    pub currency: String,

    // License 文件内容
    pub license_file_content: JsonValue,

    // 状态与续费
    pub status: String, // active | grace | expired | revoked
    pub parent_license_id: Option<i32>,
    pub renewed_to_license_id: Option<i32>,

    // 维护费（Annual Maintenance Agreement）
    pub has_maintenance: bool,
    pub maintenance_expires_at: Option<DateTime<Utc>>,
    pub maintenance_price: Option<Decimal>,
    pub maintenance_commission_rate: Option<Decimal>,
    pub auto_renew_maintenance: bool,

    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 佣金记录
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PartnerCommission {
    pub id: i32,
    pub partner_id: i32,
    pub license_id: i32,

    pub base_price: Decimal,
    pub commission_rate: Decimal,
    pub commission_amount: Decimal,
    pub currency: String,

    pub status: String, // pending | approved | paid | settled
    pub settlement_date: Option<DateTime<Utc>>,
    pub statement_id: Option<i32>,

    // 佣金类型区分
    pub commission_type: String, // license | maintenance | renewal
    pub renewal_year: i32,       // 0=新签，1=第1年续费，2=第2年续费...
    pub related_license_id: Option<Uuid>,

    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 维护费续费记录
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct MaintenanceRenewal {
    pub id: i32,
    pub license_id: Uuid,
    pub partner_id: i32,

    // 续费信息
    pub renewal_year: i32, // 第几年续费（1, 2, 3...）
    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,

    // 价格与佣金
    pub maintenance_price: Decimal,
    pub commission_rate: Decimal,
    pub commission_amount: Decimal,
    pub currency: String,

    // 支付状态
    pub payment_status: String, // pending | paid | overdue | cancelled
    pub paid_at: Option<DateTime<Utc>>,
    pub payment_reference: Option<String>,

    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 对账单
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PartnerStatement {
    pub id: i32,
    pub partner_id: i32,

    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,

    pub total_licenses: i32,
    pub total_revenue: Decimal,
    pub total_commission: Decimal,
    pub currency: String,

    // 维护费统计
    pub total_maintenance_revenue: Option<Decimal>,
    pub total_maintenance_commission: Option<Decimal>,
    pub maintenance_count: Option<i32>,

    pub status: String, // draft | pending | paid | settled
    pub statement_file_url: Option<String>,
    pub paid_at: Option<DateTime<Utc>>,
    pub payment_reference: Option<String>,

    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 代理商统计（从视图查询）
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PartnerStats {
    pub partner_id: i32,
    pub name: String,
    pub slug: String,
    pub status: String,
    pub license_quota: i32,
    pub used_quota: i32,
    pub commission_rate: Decimal,

    pub total_licenses: Option<i64>,
    pub active_licenses: Option<i64>,
    pub subscription_licenses: Option<i64>,
    pub perpetual_licenses: Option<i64>,

    // 维护费统计
    pub licenses_with_maintenance: Option<i64>,
    pub active_maintenance_count: Option<i64>,
    pub total_maintenance_value: Option<Decimal>,

    // 佣金统计（区分类型）
    pub license_commission: Option<Decimal>,
    pub maintenance_commission: Option<Decimal>,
    pub total_commission: Option<Decimal>,
    pub settled_commission: Option<Decimal>,
    pub pending_commission: Option<Decimal>,

    pub last_license_issued: Option<DateTime<Utc>>,
    pub last_commission_date: Option<DateTime<Utc>>,

    pub created_at: DateTime<Utc>,
}

// ═══════════════════════════════════════════════════════════
// 请求模型
// ═══════════════════════════════════════════════════════════

/// 创建代理商请求
#[derive(Debug, Deserialize)]
pub struct CreatePartnerRequest {
    pub name: String,
    pub company_name: String,
    pub slug: String,
    pub contact_email: String,
    pub contact_phone: Option<String>,

    #[serde(default = "default_commission_rate")]
    pub commission_rate: Decimal,
    #[serde(default = "default_payment_terms")]
    pub payment_terms: i32,
    pub license_quota: i32,
    pub quota_expires_at: Option<DateTime<Utc>>,

    pub allowed_editions: Vec<String>,
    pub allowed_modules: Vec<String>,
    pub max_license_days: Option<i32>,
}

fn default_commission_rate() -> Decimal {
    Decimal::new(1000, 2) // 10.00
}

fn default_payment_terms() -> i32 {
    30
}

/// 更新代理商请求
#[derive(Debug, Deserialize)]
pub struct UpdatePartnerRequest {
    pub name: Option<String>,
    pub company_name: Option<String>,
    pub contact_email: Option<String>,
    pub contact_phone: Option<String>,
    pub status: Option<String>,

    pub commission_rate: Option<Decimal>,
    pub payment_terms: Option<i32>,
    pub license_quota: Option<i32>,
    pub quota_expires_at: Option<DateTime<Utc>>,

    pub allowed_editions: Option<Vec<String>>,
    pub allowed_modules: Option<Vec<String>>,
    pub max_license_days: Option<i32>,
}

/// 代理商签发 License 请求
#[derive(Debug, Deserialize)]
pub struct IssueLicenseRequest {
    pub customer_name: String,
    pub customer_company: Option<String>,
    pub customer_email: Option<String>,
    pub customer_contact_phone: Option<String>,

    pub edition: String,
    pub modules: Vec<String>,
    #[serde(default = "default_max_nodes")]
    pub max_nodes: i32,
    #[serde(default = "default_max_tenants")]
    pub max_tenants: i32,
    pub max_accounts_per_tenant: Option<i32>, // 每个租户的账号上限
    pub fingerprint: Option<String>, // 客户部署指纹（可选绑定）

    pub days: i32, // License 有效天数
    #[serde(default = "default_grace_days")]
    pub grace_days: i32,

    pub license_type: String, // subscription | perpetual
    pub price: Decimal,
    #[serde(default = "default_currency")]
    pub currency: String,

    // 维护费选项
    #[serde(default)]
    pub include_maintenance: bool, // 是否包含年度维护
    #[serde(default = "default_maintenance_years")]
    pub maintenance_years: i32, // 购买几年维护（1-5）
    pub maintenance_price_override: Option<Decimal>, // 自定义维护费价格（可选）
    #[serde(default = "default_maintenance_commission_rate")]
    pub maintenance_commission_rate: Decimal, // 维护费分成比例（默认 10%）
    #[serde(default)]
    pub auto_renew_maintenance: bool, // 是否自动续费维护
}

fn default_max_nodes() -> i32 {
    1
}

fn default_max_tenants() -> i32 {
    1
}

fn default_grace_days() -> i32 {
    30
}

fn default_currency() -> String {
    "CNY".to_string()
}

fn default_maintenance_years() -> i32 {
    1
}

fn default_maintenance_commission_rate() -> Decimal {
    Decimal::new(1000, 2) // 10.00%
}

/// 续费 License 请求
#[derive(Debug, Deserialize)]
pub struct RenewLicenseRequest {
    pub days: i32, // 续费天数
    pub price: Decimal,
    #[serde(default = "default_currency")]
    pub currency: String,
}

/// 生成对账单请求
#[derive(Debug, Deserialize)]
pub struct GenerateStatementRequest {
    pub partner_id: i32,
    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,
}

/// 标记对账单支付请求
#[derive(Debug, Deserialize)]
pub struct MarkStatementPaidRequest {
    pub payment_reference: Option<String>,
}

// ═══════════════════════════════════════════════════════════
// 响应模型
// ═══════════════════════════════════════════════════════════

/// License 签发响应
#[derive(Debug, Serialize)]
pub struct IssueLicenseResponse {
    pub license_id: Uuid,
    pub customer_license_id: i32,
    pub license_file: JsonValue, // 完整的 LicenseFile JSON
    pub expires_at: DateTime<Utc>,
    pub commission_amount: Decimal,

    // 维护费信息
    pub has_maintenance: bool,
    pub maintenance_expires_at: Option<DateTime<Utc>>,
    pub maintenance_price: Option<Decimal>,
    pub maintenance_commission: Option<Decimal>,
}

/// 代理商统计响应
#[derive(Debug, Serialize)]
pub struct PartnerStatsResponse {
    pub partner: Partner,
    pub stats: PartnerStats,
}

/// 代理商配置响应（给前端用于渲染配置）
#[derive(Debug, Serialize)]
pub struct PartnerProfile {
    pub partner: Partner,
    pub available_quota: i32, // = license_quota - used_quota
    pub quota_usage_percent: Decimal,
}

// ═══════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════

impl Partner {
    /// 检查配额是否充足
    pub fn has_quota(&self, required: i32) -> bool {
        self.used_quota + required <= self.license_quota
    }

    /// 检查配额是否过期
    pub fn is_quota_expired(&self) -> bool {
        if let Some(expires_at) = self.quota_expires_at {
            expires_at < Utc::now()
        } else {
            false
        }
    }

    /// 检查版本是否允许
    pub fn is_edition_allowed(&self, edition: &str) -> bool {
        if let Some(editions) = self.allowed_editions.as_array() {
            editions.iter().any(|e| e.as_str() == Some(edition))
        } else {
            false
        }
    }

    /// 检查模块是否都允许
    pub fn are_modules_allowed(&self, modules: &[String]) -> bool {
        if let Some(allowed) = self.allowed_modules.as_array() {
            let allowed_set: Vec<&str> = allowed
                .iter()
                .filter_map(|m| m.as_str())
                .collect();

            modules.iter().all(|m| allowed_set.contains(&m.as_str()))
        } else {
            false
        }
    }

    /// 检查天数是否在限制内
    pub fn is_days_allowed(&self, days: i32) -> bool {
        if let Some(max_days) = self.max_license_days {
            days <= max_days
        } else {
            true // 无限制
        }
    }
}

impl CustomerLicense {
    /// 是否已过期（不含宽限期）
    pub fn is_expired(&self) -> bool {
        self.expires_at < Utc::now()
    }

    /// 是否在宽限期内
    pub fn is_in_grace_period(&self) -> bool {
        if !self.is_expired() {
            return false;
        }
        let grace_end = self.expires_at + chrono::Duration::days(self.grace_days as i64);
        Utc::now() <= grace_end
    }

    /// 计算当前状态
    pub fn compute_status(&self) -> String {
        if self.status == "revoked" {
            return "revoked".to_string();
        }

        if !self.is_expired() {
            "active".to_string()
        } else if self.is_in_grace_period() {
            "grace".to_string()
        } else {
            "expired".to_string()
        }
    }

    /// 是否有活跃的维护服务
    pub fn has_active_maintenance(&self) -> bool {
        if !self.has_maintenance {
            return false;
        }

        if let Some(expires_at) = self.maintenance_expires_at {
            expires_at > Utc::now()
        } else {
            false
        }
    }

    /// 维护服务是否即将过期（30 天内）
    pub fn is_maintenance_expiring_soon(&self) -> bool {
        if let Some(expires_at) = self.maintenance_expires_at {
            let days_remaining = (expires_at - Utc::now()).num_days();
            days_remaining > 0 && days_remaining <= 30
        } else {
            false
        }
    }

    /// 计算维护费价格（如果未设置，默认为 License 价格的 20%）
    pub fn calculate_maintenance_price(&self) -> Decimal {
        if let Some(price) = self.maintenance_price {
            price
        } else {
            // 默认维护费 = License 价格 × 20%
            self.price * Decimal::new(20, 2)
        }
    }
}
