# OneBase 代理商分销系统使用指南

## 概述

OneBase 代理商分销系统已完成实施，支持三方关系：**原厂 → 代理商 → 企业客户（self-hosted）**

### 核心能力
- ✅ 单层代理体系（所有代理商平级）
- ✅ 混合 License 模式（订阅制 + 永久买断）
- ✅ 代理商自助签发 License（无需原厂审批）
- ✅ 完整财务管理（佣金计算、对账单生成、支付跟踪）
- ✅ License 防破解（RSA-2048 签名 + 硬件指纹绑定）

---

## 一、快速开始

### 1.1 生成 License 密钥对

```bash
# 生成 RSA-2048 密钥对
cargo run --bin license_tool keygen --out-dir ./keys --name partner

# 生成的文件：
# - keys/partner_private.pem  (私钥，仅原厂保管，绝不入库！)
# - keys/partner_public.pem   (公钥，需要编译进二进制)
```

### 1.2 配置公钥（编译期嵌入）

```bash
# 将公钥复制到源码目录（覆盖占位文件）
cp keys/partner_public.pem src/license_public.pem

# 重新编译（公钥会内嵌到二进制中）
cargo build --release
```

### 1.3 配置环境变量

```bash
# 私钥（用于签发 License，绝不泄露！）
export ONEBASE_LICENSE_PRIVATE_KEY="$(cat keys/partner_private.pem)"

# 加密密钥（用于客户硬件指纹加密）
export ENCRYPTION_KEY="<your-existing-base64-key>"
```

### 1.4 运行数据库迁移

```bash
cargo run --bin migrate_all
```

---

## 二、代理商管理（超管操作）

### 2.1 创建代理商

```bash
curl -X POST http://localhost:3010/api/admin/partners \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "华东区代理商",
    "company_name": "上海云联科技有限公司",
    "slug": "huadong-partner",
    "contact_email": "partner@yunlian.com",
    "contact_phone": "021-12345678",
    "commission_rate": 15.00,
    "payment_terms": 30,
    "license_quota": 500,
    "quota_expires_at": "2027-12-31T23:59:59Z",
    "allowed_editions": ["standard", "enterprise"],
    "allowed_modules": ["ai", "ha", "backup", "multitenant"],
    "max_license_days": 365
  }'
```

**参数说明**：
- `commission_rate`: 佣金比例（0-100，例如 15.00 表示 15%）
- `payment_terms`: 账期天数（默认 30 天）
- `license_quota`: 总 License 配额
- `quota_expires_at`: 配额过期时间（可选）
- `allowed_editions`: 允许签发的版本（standard/enterprise/trial）
- `allowed_modules`: 允许签发的模块（ai/ha/backup/multitenant/audit/pipeline）
- `max_license_days`: 单个 License 最长有效天数（NULL = 不限制）

### 2.2 关联用户到代理商

创建代理商后，需要将用户关联到代理商：

```sql
-- 方式 1: 直接插入数据库
INSERT INTO management.partner_users (partner_id, user_id, role, is_active)
VALUES (1, <user_id>, 'admin', true);

-- 方式 2: 通过 API（待实现）
-- POST /api/admin/partners/:id/users
```

**角色说明**：
- `admin`: 代理商管理员（可签发 License、查看对账单）
- `member`: 代理商成员（仅查看权限）

### 2.3 查询代理商列表

```bash
curl -X GET "http://localhost:3010/api/admin/partners?status=active&page=1&page_size=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**查询参数**：
- `status`: 状态筛选（active/suspended/inactive）
- `page`: 页码（默认 1）
- `page_size`: 每页数量（默认 20，最大 100）

### 2.4 更新代理商信息

```bash
curl -X PATCH http://localhost:3010/api/admin/partners/1 \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "commission_rate": 18.00,
    "license_quota": 1000,
    "status": "active"
  }'
```

### 2.5 挂起代理商

```bash
curl -X DELETE http://localhost:3010/api/admin/partners/1 \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

挂起后代理商状态变为 `suspended`，无法签发新 License。

### 2.6 查看代理商统计

```bash
curl -X GET http://localhost:3010/api/admin/partners/1/statistics \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**返回数据**：
- 总 License 数、活跃 License 数
- 订阅制 vs 永久买断数量
- 总佣金、已结算佣金、待结算佣金

---

## 三、License 签发（代理商操作）

### 3.1 查看代理商配置

```bash
curl -X GET http://localhost:3010/api/partner/profile \
  -H "Authorization: Bearer $PARTNER_TOKEN"
```

**返回信息**：
- 可用配额（available_quota = license_quota - used_quota）
- 配额使用率（quota_usage_percent）
- 授权范围（allowed_editions, allowed_modules）

### 3.2 签发 License

```bash
curl -X POST http://localhost:3010/api/partner/licenses \
  -H "Authorization: Bearer $PARTNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_name": "上海某某科技有限公司",
    "customer_company": "上海某某科技有限公司",
    "customer_email": "admin@example.com",
    "customer_contact_phone": "021-88888888",
    "edition": "enterprise",
    "modules": ["ai", "ha"],
    "max_nodes": 5,
    "max_tenants": 10,
    "fingerprint": "a1b2c3d4e5f6",
    "days": 365,
    "grace_days": 30,
    "license_type": "subscription",
    "price": 100000.00,
    "currency": "CNY"
  }'
```

**参数说明**：
- `edition`: 版本（standard/enterprise）
- `modules`: 模块列表（必须在 allowed_modules 范围内）
- `max_nodes`: 最大节点数（默认 1）
- `max_tenants`: 最大租户数（默认 1）
- `fingerprint`: 客户部署指纹（可选，绑定后 License 只能在该硬件上使用）
- `days`: 有效天数（必须 <= max_license_days）
- `grace_days`: 宽限期天数（默认 30）
- `license_type`: 类型（subscription=订阅制, perpetual=永久买断）
- `price`: 销售价格（用于佣金计算）

**返回数据**：
```json
{
  "license_id": "550e8400-e29b-41d4-a716-446655440000",
  "customer_license_id": 123,
  "license_file": {
    "alg": "RS256",
    "payload": "base64...",
    "signature": "base64..."
  },
  "expires_at": "2027-09-01T00:00:00Z",
  "commission_amount": 15000.00
}
```

**将 license_file 交付给客户**：
```bash
# 保存为 license.lic
echo '<license_file JSON>' > license.lic

# 客户部署时放到指定路径
cp license.lic /etc/onebase/license.lic
```

### 3.3 续费 License

```bash
curl -X POST http://localhost:3010/api/partner/licenses/123/renew \
  -H "Authorization: Bearer $PARTNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "days": 365,
    "price": 80000.00,
    "currency": "CNY"
  }'
```

**说明**：
- 续费会生成新的 License 文件（新 UUID）
- 新 License 的 `parent_license_id` 指向原 License
- 原 License 的 `renewed_to_license_id` 指向新 License
- 续费也消耗配额

### 3.4 查询客户 License 列表

```bash
curl -X GET "http://localhost:3010/api/partner/customers?status=active&page=1" \
  -H "Authorization: Bearer $PARTNER_TOKEN"
```

**查询参数**：
- `status`: 状态筛选（active/grace/expired/revoked）
- `customer_name`: 客户名称模糊搜索
- `page`, `page_size`: 分页参数

---

## 四、财务管理

### 4.1 查看佣金记录

```bash
curl -X GET http://localhost:3010/api/partner/commissions \
  -H "Authorization: Bearer $PARTNER_TOKEN"
```

**佣金状态**：
- `pending`: 待审核（刚签发 License）
- `approved`: 已批准（关联到对账单）
- `paid`: 已支付（超管标记）
- `settled`: 已结算（最终状态）

### 4.2 查看对账单

```bash
curl -X GET http://localhost:3010/api/partner/statements \
  -H "Authorization: Bearer $PARTNER_TOKEN"
```

**对账单包含**：
- 周期（period_start ~ period_end）
- 总 License 数、总营收、总佣金
- 状态（draft/pending/paid/settled）
- 支付凭证（payment_reference）

### 4.3 生成对账单（超管）

```bash
curl -X POST http://localhost:3010/api/admin/statements/generate \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "partner_id": 1,
    "period_start": "2026-08-01T00:00:00Z",
    "period_end": "2026-09-01T00:00:00Z"
  }'
```

**自动化**：每月 1 号凌晨系统会自动为所有代理商生成上月对账单。

### 4.4 标记对账单已支付（超管）

```bash
curl -X POST http://localhost:3010/api/admin/statements/1/paid \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "payment_reference": "转账凭证号: 20260901001"
  }'
```

---

## 五、License 安全机制

### 5.1 签名验证

**签名算法**：RSA-2048 + SHA-256（与现有 license.rs 一致）

```
1. 原厂私钥签名 → License 文件（JSON）
2. 客户部署时，OneBase 用内嵌公钥验证签名
3. 签名不匹配 → License 无效，系统拒绝启动
```

**防破解措施**：
- 私钥仅原厂持有（通过环境变量注入）
- 公钥编译期内嵌到二进制中（无法替换）
- License 文件任何修改都会导致签名验证失败

### 5.2 硬件指纹绑定

**可选功能**：签发时指定 `fingerprint` 参数

```bash
# 客户先获取自己的部署指纹
export ONEBASE_DEPLOY_FINGERPRINT=$(hostname | sha256sum | cut -c1-16)

# 代理商签发时绑定
{
  "fingerprint": "a1b2c3d4e5f6",
  ...
}
```

**效果**：
- License 只能在指定硬件上激活
- 复制到其他服务器会提示"部署指纹不匹配"
- 适用于严格的 License 管控场景

### 5.3 宽限期机制

**三阶段状态**：
1. **active**（活跃）：expires_at 未到期
2. **grace**（宽限期）：expires_at 已过期，但在 grace_days 内
3. **expired**（已过期）：超过宽限期

**系统行为**：
- `active`: 正常运行
- `grace`: 可以继续使用，但显示"即将到期"警告
- `expired`: 进入只读降级模式（拦截写操作）

**定时任务**：每小时自动更新 License 状态（active → grace → expired）

---

## 六、后台定时任务

### 6.1 月度对账单生成

**触发时间**：每月 1 号凌晨 0-1 点

**执行逻辑**：
1. 遍历所有 `status='active'` 的代理商
2. 统计上月签发的 License（总数、总营收、总佣金）
3. 创建对账单（status='pending'）
4. 将相关佣金记录关联到对账单（status: pending → approved）

**日志**：
```
[INFO] 开始生成月度对账单：2026-08-01 至 2026-09-01
[INFO] 代理商 1 对账单生成成功
[INFO] 月度对账单生成完成：成功 10，失败 0
```

### 6.2 License 状态更新

**触发频率**：每小时

**执行逻辑**：
1. 更新 `active` → `grace`（已过期但在宽限期内）
2. 更新 `grace/active` → `expired`（宽限期已满）

**SQL**：
```sql
-- active → grace
UPDATE customer_licenses
SET status = 'grace'
WHERE status = 'active'
  AND expires_at < NOW()
  AND expires_at + (grace_days || ' days')::interval >= NOW();

-- grace → expired
UPDATE customer_licenses
SET status = 'expired'
WHERE status IN ('active', 'grace')
  AND expires_at + (grace_days || ' days')::interval < NOW();
```

---

## 七、故障排查

### 7.1 License 签发失败

**错误 1**：`代理商状态为 'suspended'，无法签发 License`
- **原因**：代理商已被挂起
- **解决**：联系超管重新激活

**错误 2**：`配额不足（已用 500/500）`
- **原因**：License 配额耗尽
- **解决**：联系超管增加配额

**错误 3**：`版本 'enterprise' 不在授权范围内`
- **原因**：代理商未被授权签发该版本
- **解决**：联系超管更新 `allowed_editions`

**错误 4**：`签发天数 730 超过限制（最大 365 天）`
- **原因**：超过 `max_license_days` 限制
- **解决**：减少 `days` 参数，或联系超管调整限制

### 7.2 License 验证失败（客户端）

**错误 1**：`License 签名校验失败（文件被篡改或公钥不匹配）`
- **原因**：License 文件损坏或被修改
- **解决**：重新从代理商获取 License 文件

**错误 2**：`部署指纹不匹配（授权绑定 a1b2c3, 当前 d4e5f6）`
- **原因**：License 绑定了其他硬件
- **解决**：在正确的服务器上部署，或联系代理商重新签发

**错误 3**：`授权已过期，系统进入只读降级模式`
- **原因**：License 已过宽限期
- **解决**：联系代理商续费

### 7.3 私钥配置错误

**错误**：`未配置 ONEBASE_LICENSE_PRIVATE_KEY`
- **解决**：
```bash
export ONEBASE_LICENSE_PRIVATE_KEY="$(cat keys/partner_private.pem)"
```

**错误**：`解析私钥失败`
- **原因**：私钥格式错误
- **解决**：确保是 PKCS#8 格式的 PEM 文件（`-----BEGIN PRIVATE KEY-----`）

---

## 八、数据库直接操作

### 8.1 手动调整代理商配额

```sql
UPDATE management.partners
SET license_quota = 1000, used_quota = 0
WHERE id = 1;
```

### 8.2 查询代理商统计

```sql
SELECT * FROM management.v_partner_stats WHERE partner_id = 1;
```

### 8.3 吊销 License

```sql
UPDATE management.customer_licenses
SET status = 'revoked'
WHERE id = 123;
```

### 8.4 查询佣金汇总

```sql
SELECT
  p.name AS partner_name,
  COUNT(*) AS total_commissions,
  SUM(commission_amount) AS total_amount,
  SUM(CASE WHEN status = 'pending' THEN commission_amount ELSE 0 END) AS pending_amount,
  SUM(CASE WHEN status = 'paid' THEN commission_amount ELSE 0 END) AS paid_amount
FROM management.partner_commissions pc
JOIN management.partners p ON p.id = pc.partner_id
GROUP BY p.id, p.name
ORDER BY total_amount DESC;
```

---

## 九、安全最佳实践

### 9.1 私钥管理

❌ **绝对禁止**：
- 将私钥提交到 Git 仓库
- 将私钥硬编码到代码中
- 通过邮件/IM 传输私钥明文

✅ **推荐做法**：
- 使用环境变量或 Kubernetes Secrets 注入
- 生产环境使用 AWS Secrets Manager / HashiCorp Vault
- 定期轮换密钥（需要重新签发所有 License）
- 限制私钥访问权限（仅原厂核心人员）

### 9.2 配额监控

```sql
-- 配额使用率 > 80% 的代理商
SELECT
  id, name, used_quota, license_quota,
  ROUND(used_quota::numeric / license_quota * 100, 2) AS usage_percent
FROM management.partners
WHERE license_quota > 0
  AND used_quota::numeric / license_quota > 0.8
ORDER BY usage_percent DESC;
```

**告警建议**：配额使用率达到 80% 时发送邮件通知代理商。

### 9.3 审计日志

所有 License 签发操作会自动记录到 `management.audit_logs`：

```sql
SELECT
  al.action, al.resource_type, al.resource_id,
  al.details->>'customer_name' AS customer_name,
  al.details->>'price' AS price,
  al.created_at,
  u.email AS operator
FROM management.audit_logs al
JOIN users u ON u.id = al.user_id
WHERE al.resource_type = 'customer_license'
ORDER BY al.created_at DESC
LIMIT 100;
```

---

## 十、扩展功能（待实现）

### Phase 2
- [ ] License 批量签发（Excel 导入）
- [ ] 对账单导出（PDF/Excel）
- [ ] 配额预警（使用率 80% 自动邮件通知）
- [ ] License 吊销 API（超管/代理商主动吊销）

### Phase 3
- [ ] License 使用统计（客户端心跳上报）
- [ ] 二级代理商（层级分销）
- [ ] 自动续费提醒（到期前 30 天邮件通知）
- [ ] 代理商自助注册（审批流程）

---

## 附录 A：数据库表结构速查

### partners
| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL | 主键 |
| name | VARCHAR(100) | 代理商名称 |
| commission_rate | DECIMAL(5,2) | 佣金比例 (0-100) |
| license_quota | INTEGER | 总配额 |
| used_quota | INTEGER | 已用配额 |
| status | VARCHAR(20) | active/suspended/inactive |

### customer_licenses
| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL | 主键 |
| license_id | UUID | License UUID（对外唯一标识）|
| partner_id | INTEGER | 代理商 ID |
| customer_name | VARCHAR(200) | 客户名称 |
| edition | VARCHAR(50) | 版本 |
| modules | JSONB | 模块列表 |
| expires_at | TIMESTAMP | 到期时间 |
| license_type | VARCHAR(20) | subscription/perpetual |
| price | DECIMAL(12,2) | 销售价格 |
| status | VARCHAR(20) | active/grace/expired/revoked |

### partner_commissions
| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL | 主键 |
| partner_id | INTEGER | 代理商 ID |
| license_id | INTEGER | License ID |
| commission_amount | DECIMAL(12,2) | 佣金金额 |
| status | VARCHAR(20) | pending/approved/paid/settled |
| statement_id | INTEGER | 对账单 ID |

---

## 附录 B：API 完整列表

### 超管 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/partners` | 创建代理商 |
| GET | `/api/admin/partners` | 查询代理商列表 |
| PATCH | `/api/admin/partners/:id` | 更新代理商 |
| DELETE | `/api/admin/partners/:id` | 挂起代理商 |
| GET | `/api/admin/partners/:id/statistics` | 获取统计 |
| POST | `/api/admin/statements/generate` | 生成对账单 |
| POST | `/api/admin/statements/:id/paid` | 标记已支付 |

### 代理商 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/partner/profile` | 获取配置 |
| GET | `/api/partner/customers` | 查询客户列表 |
| POST | `/api/partner/licenses` | 签发 License |
| POST | `/api/partner/licenses/:id/renew` | 续费 License |
| GET | `/api/partner/commissions` | 查询佣金记录 |
| GET | `/api/partner/statements` | 查询对账单 |

---

**文档版本**：v1.0
**更新日期**：2026-09-01
**实施状态**：✅ 已完成
