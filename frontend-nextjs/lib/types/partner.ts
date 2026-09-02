// 代理商分销系统类型定义

export interface Partner {
  id: number
  name: string
  company_name: string
  slug: string
  contact_email: string
  contact_phone: string | null
  status: 'active' | 'suspended' | 'inactive'

  // 佣金与配额
  commission_rate: string // Decimal from Rust
  payment_terms: number
  license_quota: number
  used_quota: number
  quota_expires_at: string | null

  // 授权范围
  allowed_editions: string[] // JSON array
  allowed_modules: string[] // JSON array
  max_license_days: number | null

  created_at: string
  updated_at: string
}

export interface PartnerStats {
  partner_id: number
  name: string
  slug: string
  status: string
  license_quota: number
  used_quota: number
  commission_rate: string

  total_licenses: number | null
  active_licenses: number | null
  subscription_licenses: number | null
  perpetual_licenses: number | null

  total_commission: string | null
  settled_commission: string | null
  pending_commission: string | null

  created_at: string
}

export interface CustomerLicense {
  id: number
  partner_id: number
  license_id: string // UUID

  // 客户信息
  customer_name: string
  customer_company: string | null
  customer_email: string | null
  customer_contact_phone: string | null

  // License 配置
  edition: string
  modules: string[] // JSON array
  max_nodes: number
  max_tenants: number
  fingerprint_encrypted: string | null

  // 时间配置
  issued_at: string
  expires_at: string
  grace_days: number

  // License 类型与价格
  license_type: 'subscription' | 'perpetual'
  price: string // Decimal
  currency: string

  // License 文件内容
  license_file_content: any // JSONB

  // 状态与续费
  status: 'active' | 'grace' | 'expired' | 'revoked'
  parent_license_id: number | null
  renewed_to_license_id: number | null

  created_at: string
  updated_at: string
}

export interface PartnerCommission {
  id: number
  partner_id: number
  license_id: number

  base_price: string // Decimal
  commission_rate: string // Decimal
  commission_amount: string // Decimal
  currency: string

  status: 'pending' | 'approved' | 'paid' | 'settled'
  settlement_date: string | null
  statement_id: number | null

  created_at: string
  updated_at: string
}

export interface PartnerStatement {
  id: number
  partner_id: number

  period_start: string
  period_end: string

  total_licenses: number
  total_revenue: string // Decimal
  total_commission: string // Decimal
  currency: string

  status: 'draft' | 'pending' | 'paid' | 'settled'
  statement_file_url: string | null
  paid_at: string | null
  payment_reference: string | null

  created_at: string
  updated_at: string
}

export interface PartnerProfile {
  partner: Partner
  available_quota: number
  quota_usage_percent: string // Decimal
}

// ========== 请求类型 ==========

export interface CreatePartnerRequest {
  name: string
  company_name: string
  slug: string
  contact_email: string
  contact_phone?: string

  commission_rate?: number
  payment_terms?: number
  license_quota: number
  quota_expires_at?: string

  allowed_editions: string[]
  allowed_modules: string[]
  max_license_days?: number
}

export interface UpdatePartnerRequest {
  name?: string
  company_name?: string
  contact_email?: string
  contact_phone?: string
  status?: 'active' | 'suspended' | 'inactive'

  commission_rate?: number
  payment_terms?: number
  license_quota?: number
  quota_expires_at?: string

  allowed_editions?: string[]
  allowed_modules?: string[]
  max_license_days?: number
}

export interface IssueLicenseRequest {
  customer_name: string
  customer_company?: string
  customer_email?: string
  customer_contact_phone?: string

  edition: string
  modules: string[]
  max_nodes?: number
  max_tenants?: number
  fingerprint?: string

  days: number
  grace_days?: number

  license_type: 'subscription' | 'perpetual'
  price: number
  currency?: string
}

export interface RenewLicenseRequest {
  days: number
  price: number
  currency?: string
}

export interface GenerateStatementRequest {
  partner_id: number
  period_start: string
  period_end: string
}

export interface MarkStatementPaidRequest {
  payment_reference?: string
}

// ========== 响应类型 ==========

export interface IssueLicenseResponse {
  license_id: string
  customer_license_id: number
  license_file: any // LicenseFile JSON
  expires_at: string
  commission_amount: string
}

export interface PartnerStatsResponse {
  partner: Partner
  stats: PartnerStats
}

// ========== 分页响应 ==========

export interface PaginatedResponse<T> {
  [key: string]: T[] | PaginationInfo
  pagination: PaginationInfo
}

export interface PaginationInfo {
  page: number
  page_size: number
  total: number
  total_pages: number
}
