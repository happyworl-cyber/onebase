# OneBase 维护费 API 文档

## 概述

本文档详细说明了 OneBase 代理商分销系统中维护费相关的 API 端点，包括 License 签发（含维护费）、维护费续费管理、查询统计等功能。

**基础URL**：`http://localhost:3010`（开发环境）

**认证方式**：Bearer Token（JWT）

**时间格式**：ISO 8601（`2026-09-01T00:00:00Z`）

**货币单位**：人民币（CNY），金额单位为分（需除以 100 转换为元）

---

## 目录

- [代理商 API](#代理商-api)
  - [签发 License（含维护费）](#1-签发-license含维护费)
  - [续费 License](#2-续费-license)
  - [查询维护费续费记录](#3-查询维护费续费记录)
  - [标记维护费已支付](#4-标记维护费已支付)
  - [获取即将到期的维护服务](#5-获取即将到期的维护服务)
- [超管 API](#超管-api)
  - [生成对账单（区分维护费）](#6-生成对账单区分维护费)
- [数据模型](#数据模型)
- [错误码](#错误码)

---

## 代理商 API

### 1. 签发 License（含维护费）

**端点**：`POST /api/partner/licenses`

**权限**：需要代理商认证

**描述**：为客户签发 License，可选择包含年度维护服务。

#### 请求体

```json
{
  "customer_name": "客户公司A",
  "customer_company": "A科技有限公司",
  "customer_email": "contact@companya.com",
  "customer_contact_phone": "+86-138-0000-0000",

  "edition": "enterprise",
  "modules": ["ai", "ha"],
  "max_nodes": 10,
  "max_tenants": 50,
  "max_accounts_per_tenant": 200,
  "fingerprint": "server001.companya.com",

  "days": 365,
  "grace_days": 30,
  "license_type": "perpetual",
  "price": 30000000,
  "currency": "CNY",

  "include_maintenance": true,
  "maintenance_years": 3,
  "maintenance_price_override": null,
  "maintenance_commission_rate": 1000,
  "auto_renew_maintenance": false
}
```

#### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `customer_name` | string | ✅ | 客户名称 |
| `customer_company` | string | - | 客户公司名称 |
| `customer_email` | string | - | 客户邮箱 |
| `customer_contact_phone` | string | - | 客户联系电话 |
| `edition` | string | ✅ | 版本：trial / standard / enterprise |
| `modules` | array | ✅ | 模块列表：ai, ha, multitenant, audit, pipeline 等 |
| `max_nodes` | integer | - | 最大节点数（默认 1） |
| `max_tenants` | integer | - | 最大租户数（默认 1） |
| `max_accounts_per_tenant` | integer | - | 每租户最大账号数 |
| `fingerprint` | string | - | 硬件指纹（绑定部署环境） |
| `days` | integer | ✅ | License 有效天数 |
| `grace_days` | integer | - | 宽限期天数（默认 30） |
| `license_type` | string | ✅ | 类型：subscription（订阅）/ perpetual（买断） |
| `price` | integer | ✅ | License 价格（分）|
| `currency` | string | - | 货币（默认 CNY） |
| **`include_maintenance`** | boolean | - | **是否包含维护服务**（默认 false） |
| **`maintenance_years`** | integer | - | **购买几年维护**（1-5，默认 1） |
| **`maintenance_price_override`** | integer | - | **自定义维护费价格**（分，默认为 price × 20%） |
| **`maintenance_commission_rate`** | integer | - | **维护费分成比例**（默认 1000 = 10%） |
| **`auto_renew_maintenance`** | boolean | - | **是否自动续费维护**（默认 false） |

#### 响应示例

```json
{
  "license_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "customer_license_id": 123,
  "license_file": {
    "version": "1.0",
    "license_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "customer": "客户公司A",
    "edition": "enterprise",
    "modules": ["ai", "ha"],
    "max_nodes": 10,
    "max_tenants": 50,
    "max_accounts_per_tenant": 200,
    "issued_at": 1725235200,
    "expires_at": 1756771200,
    "grace_days": 30,
    "fingerprint": "server001.companya.com",
    "signature": "-----BEGIN LICENSE SIGNATURE-----\nMIIE...-----END LICENSE SIGNATURE-----"
  },
  "expires_at": "2027-09-01T00:00:00Z",
  "commission_amount": 4500000,

  "has_maintenance": true,
  "maintenance_expires_at": "2030-09-01T00:00:00Z",
  "maintenance_price": 6000000,
  "maintenance_commission": 1800000
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `license_id` | uuid | License 唯一标识符 |
| `customer_license_id` | integer | 数据库记录 ID |
| `license_file` | object | 完整的 License 文件（JSON 格式） |
| `expires_at` | datetime | License 到期时间 |
| `commission_amount` | integer | License 佣金（分）|
| **`has_maintenance`** | boolean | **是否包含维护** |
| **`maintenance_expires_at`** | datetime | **维护服务到期时间** |
| **`maintenance_price`** | integer | **年度维护费（分）** |
| **`maintenance_commission`** | integer | **维护费总佣金（分）** |

#### 业务逻辑

1. **维护费价格计算**：
   ```
   维护费 = maintenance_price_override ?? (price × 0.2)
   ```

2. **维护费到期时间**：
   ```
   maintenance_expires_at = expires_at + (365 天 × maintenance_years)
   ```

3. **佣金计算**：
   - License 佣金：`price × commission_rate / 10000`
   - 维护费总佣金：`maintenance_price × maintenance_years × maintenance_commission_rate / 10000`

4. **数据库操作**（事务）：
   - 插入 `customer_licenses` 记录
   - 为每年维护创建 `maintenance_renewals` 记录
   - 创建 License 佣金记录（commission_type = 'license'）
   - 创建维护费佣金记录（commission_type = 'maintenance'，每年一条）
   - 更新代理商配额（used_quota + 1）

---

### 2. 续费 License

**端点**：`POST /api/partner/licenses/:id/renew`

**权限**：需要代理商认证

**描述**：为现有 License 续费，自动继承原 License 的配置（包括维护费配置）。

#### URL 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | integer | 原 License 记录 ID |

#### 请求体

```json
{
  "days": 365,
  "price": 30000000,
  "currency": "CNY"
}
```

#### 响应示例

```json
{
  "license_id": "a8b9c1d2-1234-5678-9abc-def012345678",
  "customer_license_id": 456,
  "license_file": { ... },
  "expires_at": "2028-09-01T00:00:00Z",
  "commission_amount": 4500000,

  "has_maintenance": true,
  "maintenance_expires_at": "2031-09-01T00:00:00Z",
  "maintenance_price": 6000000,
  "maintenance_commission": null
}
```

#### 业务逻辑

1. **继承配置**：新 License 继承原 License 的：
   - edition、modules、max_nodes、max_tenants、max_accounts_per_tenant
   - fingerprint_encrypted
   - has_maintenance、maintenance_price、maintenance_commission_rate、auto_renew_maintenance

2. **维护服务延期**：
   ```
   新 maintenance_expires_at = 新 expires_at + (原 maintenance_expires_at - 原 expires_at)
   ```

3. **关联关系**：
   - 新 License 的 `parent_license_id` = 原 License ID
   - 原 License 的 `renewed_to_license_id` = 新 License ID

---

### 3. 查询维护费续费记录

**端点**：`GET /api/partner/maintenance/renewals`

**权限**：需要代理商认证

**描述**：查询当前代理商的所有维护费续费记录。

#### 查询参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `payment_status` | string | 筛选支付状态：pending / paid / overdue / cancelled |
| `expiring_soon` | boolean | 是否仅显示 30 天内到期的记录 |
| `page` | integer | 页码（默认 1） |
| `page_size` | integer | 每页数量（默认 20，最大 100） |

#### 请求示例

```
GET /api/partner/maintenance/renewals?payment_status=pending&page=1&page_size=20
```

#### 响应示例

```json
{
  "renewals": [
    {
      "id": 1,
      "license_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "partner_id": 5,
      "renewal_year": 1,
      "period_start": "2027-09-01T00:00:00Z",
      "period_end": "2028-09-01T00:00:00Z",
      "maintenance_price": 6000000,
      "commission_rate": 1000,
      "commission_amount": 600000,
      "currency": "CNY",
      "payment_status": "pending",
      "paid_at": null,
      "payment_reference": null,
      "created_at": "2026-09-01T10:00:00Z",
      "updated_at": "2026-09-01T10:00:00Z",

      "customer_name": "客户公司A",
      "customer_company": "A科技有限公司",
      "edition": "enterprise"
    }
  ],
  "pagination": {
    "page": 1,
    "page_size": 20,
    "total": 45,
    "total_pages": 3
  }
}
```

---

### 4. 标记维护费已支付

**端点**：`POST /api/partner/maintenance/:id/mark-paid`

**权限**：需要代理商认证

**描述**：标记某条维护费续费记录为已支付状态。

#### URL 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | integer | 维护费续费记录 ID |

#### 请求体

```json
{
  "payment_reference": "银行转账凭证 20260901-001"
}
```

#### 响应示例

```json
{
  "renewal": {
    "id": 1,
    "payment_status": "paid",
    "paid_at": "2026-09-01T12:30:00Z",
    "payment_reference": "银行转账凭证 20260901-001",
    ...
  },
  "message": "维护费已标记为支付状态"
}
```

---

### 5. 获取即将到期的维护服务

**端点**：`GET /api/partner/maintenance/expiring`

**权限**：需要代理商认证

**描述**：获取 30 天内到期的维护服务列表，用于提醒续费。

#### 响应示例

```json
{
  "expiring_maintenance": [
    {
      "license_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "customer_name": "客户公司A",
      "customer_company": "A科技有限公司",
      "customer_email": "contact@companya.com",
      "edition": "enterprise",
      "maintenance_expires_at": "2026-09-25T00:00:00Z",
      "maintenance_price": 6000000,
      "days_remaining": 24,
      "auto_renew_maintenance": false
    }
  ],
  "count": 1
}
```

---

## 超管 API

### 6. 生成对账单（区分维护费）

**端点**：`POST /api/admin/statements/generate`

**权限**：需要超管认证

**描述**：为指定代理商生成指定周期的对账单，区分 License 收入和维护费收入。

#### 请求体

```json
{
  "partner_id": 5,
  "period_start": "2026-08-01T00:00:00Z",
  "period_end": "2026-09-01T00:00:00Z"
}
```

#### 响应示例

```json
{
  "statement": {
    "id": 78,
    "partner_id": 5,
    "period_start": "2026-08-01T00:00:00Z",
    "period_end": "2026-09-01T00:00:00Z",

    "total_licenses": 12,
    "total_revenue": 360000000,
    "total_commission": 54000000,

    "maintenance_count": 8,
    "total_maintenance_revenue": 48000000,
    "total_maintenance_commission": 4800000,

    "currency": "CNY",
    "status": "pending",
    "created_at": "2026-09-01T00:00:00Z"
  },
  "message": "对账单生成成功"
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `total_licenses` | integer | 本期新签 License 数量 |
| `total_revenue` | integer | License 总收入（分）|
| `total_commission` | integer | License 总佣金（分）|
| **`maintenance_count`** | integer | **本期维护费续费数量** |
| **`total_maintenance_revenue`** | integer | **维护费总收入（分）** |
| **`total_maintenance_commission`** | integer | **维护费总佣金（分）** |

#### 业务逻辑

1. **License 统计**：
   ```sql
   SELECT COUNT(*), SUM(price), SUM(commission_amount)
   FROM customer_licenses cl
   JOIN partner_commissions pc ON pc.commission_type = 'license'
   WHERE period_start <= issued_at < period_end
   ```

2. **维护费统计**：
   ```sql
   SELECT COUNT(*), SUM(maintenance_price), SUM(commission_amount)
   FROM maintenance_renewals mr
   JOIN partner_commissions pc ON pc.commission_type = 'maintenance'
   WHERE period_start <= mr.period_start < period_end
   ```

---

## 数据模型

### CustomerLicense（客户 License）

```typescript
interface CustomerLicense {
  id: number;
  partner_id: number;
  license_id: string; // UUID

  // 客户信息
  customer_name: string;
  customer_company?: string;
  customer_email?: string;
  customer_contact_phone?: string;

  // License 配置
  edition: 'trial' | 'standard' | 'enterprise';
  modules: string[];
  max_nodes: number;
  max_tenants: number;
  max_accounts_per_tenant?: number;
  fingerprint_encrypted?: string;

  // 时间配置
  issued_at: Date;
  expires_at: Date;
  grace_days: number;

  // License 类型与价格
  license_type: 'subscription' | 'perpetual';
  price: number; // 分
  currency: string;

  // 维护费（新增）
  has_maintenance: boolean;
  maintenance_expires_at?: Date;
  maintenance_price?: number; // 分
  maintenance_commission_rate?: number; // 百分比 × 100（1000 = 10%）
  auto_renew_maintenance: boolean;

  // 状态
  status: 'active' | 'grace' | 'expired' | 'revoked';
  parent_license_id?: number;
  renewed_to_license_id?: number;
}
```

### MaintenanceRenewal（维护费续费记录）

```typescript
interface MaintenanceRenewal {
  id: number;
  license_id: string; // UUID
  partner_id: number;

  renewal_year: number; // 第几年续费（1, 2, 3...）
  period_start: Date;
  period_end: Date;

  maintenance_price: number; // 分
  commission_rate: number; // 百分比 × 100
  commission_amount: number; // 分
  currency: string;

  payment_status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  paid_at?: Date;
  payment_reference?: string;
}
```

### PartnerCommission（佣金记录）

```typescript
interface PartnerCommission {
  id: number;
  partner_id: number;
  license_id: number; // customer_licenses.id

  base_price: number; // 分
  commission_rate: number;
  commission_amount: number; // 分
  currency: string;

  status: 'pending' | 'approved' | 'paid' | 'settled';
  settlement_date?: Date;
  statement_id?: number;

  // 佣金类型区分（新增）
  commission_type: 'license' | 'maintenance' | 'renewal';
  renewal_year: number; // 0=新签，1=第1年续费...
  related_license_id?: string; // UUID，关联原始 License
}
```

---

## 错误码

| HTTP 状态码 | 错误码 | 说明 |
|------------|--------|------|
| 400 | `invalid_request` | 请求参数错误 |
| 401 | `unauthorized` | 未认证或 Token 过期 |
| 403 | `forbidden` | 权限不足（如配额不足、版本不允许） |
| 404 | `not_found` | 资源不存在 |
| 500 | `internal_error` | 服务器内部错误 |

### 错误响应示例

```json
{
  "error": "forbidden",
  "message": "配额不足（已用 98/100）"
}
```

### 常见错误

#### 1. 配额不足

```json
{
  "error": "forbidden",
  "message": "配额不足（已用 100/100）"
}
```

**解决方案**：联系超管增加配额或删除未使用的 License。

#### 2. 版本不在授权范围

```json
{
  "error": "forbidden",
  "message": "版本 'enterprise' 不在授权范围内"
}
```

**解决方案**：检查代理商的 `allowed_editions` 配置。

#### 3. 维护费记录不存在

```json
{
  "error": "not_found",
  "message": "维护费续费记录不存在"
}
```

**解决方案**：检查续费记录 ID 是否正确，是否属于当前代理商。

---

## 使用示例

### 场景 1：签发包含 3 年维护的 License

```bash
curl -X POST http://localhost:3010/api/partner/licenses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_name": "客户公司A",
    "edition": "enterprise",
    "modules": ["ai", "ha"],
    "max_nodes": 10,
    "max_tenants": 50,
    "max_accounts_per_tenant": 200,
    "days": 365,
    "license_type": "perpetual",
    "price": 30000000,

    "include_maintenance": true,
    "maintenance_years": 3,
    "maintenance_commission_rate": 1000,
    "auto_renew_maintenance": false
  }'
```

**预期结果**：
- 创建 1 条 `customer_licenses` 记录（has_maintenance = true）
- 创建 3 条 `maintenance_renewals` 记录（renewal_year = 1, 2, 3）
- 创建 1 条 License 佣金（commission_type = 'license'，20% 分成）
- 创建 3 条维护费佣金（commission_type = 'maintenance'，10% 分成）

### 场景 2：查询 30 天内到期的维护服务

```bash
curl -X GET "http://localhost:3010/api/partner/maintenance/expiring" \
  -H "Authorization: Bearer $TOKEN"
```

### 场景 3：标记维护费已支付

```bash
curl -X POST http://localhost:3010/api/partner/maintenance/1/mark-paid \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "payment_reference": "银行转账凭证 20260901-001"
  }'
```

---

## 最佳实践

### 1. 维护费定价建议

- **标准费率**：License 价格的 **20%**
- **多年优惠**：
  - 1 年：无优惠
  - 2 年：95% 折扣（每年维护费 × 0.95）
  - 3 年：90% 折扣（每年维护费 × 0.90）

### 2. 佣金比例建议

- **新签 License**：
  - Standard：20%
  - Enterprise：15%
- **维护费续费**：统一 **10%**

### 3. 自动续费策略

- 默认关闭 `auto_renew_maintenance`
- 到期前 30 天提醒客户
- 客户确认后再启用自动续费

### 4. 支付状态管理

| 状态 | 说明 | 后续操作 |
|------|------|---------|
| `pending` | 待支付 | 发送支付提醒 |
| `paid` | 已支付 | 延长维护到期时间 |
| `overdue` | 逾期 | 发送催款通知，考虑停止维护服务 |
| `cancelled` | 取消 | 不再提供维护服务 |

---

## 附录

### A. 维护费计算公式

```
年度维护费 = License 价格 × 0.2
维护费总价 = 年度维护费 × 购买年限
维护费佣金 = 年度维护费 × 维护费分成比例 × 购买年限
```

### B. 收入预测模型

假设某代理商：
- 签发 Standard 版（¥80,000）+ AI 模块（¥30,000）
- 包含 3 年维护
- License 分成 20%，维护费分成 10%

| 年份 | 项目 | 金额 | 代理商分成 |
|------|------|------|-----------|
| 第 1 年 | License | ¥110,000 | ¥22,000 (20%) |
| 第 2 年 | 维护续费 | ¥22,000 | ¥2,200 (10%) |
| 第 3 年 | 维护续费 | ¥22,000 | ¥2,200 (10%) |
| 第 4 年 | 维护续费 | ¥22,000 | ¥2,200 (10%) |
| **合计** | - | **¥176,000** | **¥28,600** |

**关键指标**：
- 维护费 3 年收入占比：37.5%（¥66,000 / ¥176,000）
- 代理商 4 年平均分成率：16.25%（¥28,600 / ¥176,000）
- 客户 4 年 TCO：¥176,000（远低于订阅制）

---

## 更新日志

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-09-02 | 初始版本，包含维护费所有 API |

---

**文档维护**：OneBase 开发团队
**联系方式**：support@onebase.io
**最后更新**：2026-09-02
