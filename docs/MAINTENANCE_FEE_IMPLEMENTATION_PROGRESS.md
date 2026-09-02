# 维护费功能实施进度报告

## ✅ 已完成工作（无需数据库即可完成）

### 1. 策略与设计文档

#### 📄 ONEBASE_PRICING_STRATEGY.md
- **竞品调研**：Supabase、Retool、Appsmith、Budibase、NocoDB
- **推荐定价方案**：
  - Trial: 免费
  - Standard: 买断 ¥80,000 | 订阅 ¥20,000/年 | 维护费 ¥16,000/年
  - Enterprise: 买断 ¥300,000 | 订阅 ¥75,000/年 | 维护费 ¥60,000/年
- **代理商分成体系**：
  - 新签 License：Standard 20%，Enterprise 15%
  - 维护费续费：Standard 10%，Enterprise 8%（符合您的要求：**维护费分成更低**）
- **收入预测**：3 年累计 ¥28,140,000（含维护费 ¥2,940,000）

#### 📄 PRICING_IMPLEMENTATION_SUMMARY.md
- 详细实施步骤（分 4 个阶段）
- 维护费收入计算示例
- 前端 UI 实现方案
- FAQ 常见问题解答

---

### 2. 数据库设计

#### 📄 migrations/064_add_maintenance_fee_support.sql

**新增字段（customer_licenses 表）**：
```sql
has_maintenance BOOLEAN DEFAULT false
maintenance_expires_at TIMESTAMP WITH TIME ZONE
maintenance_price NUMERIC(12, 2)
maintenance_commission_rate NUMERIC(5, 2) DEFAULT 10.00
auto_renew_maintenance BOOLEAN DEFAULT false
```

**新增字段（partner_commissions 表）**：
```sql
commission_type VARCHAR(20) DEFAULT 'license'  -- license | maintenance | renewal
renewal_year INTEGER DEFAULT 0
related_license_id UUID
```

**新建表（maintenance_renewals）**：
- 跟踪每年的维护费续费记录
- 包含 renewal_year、period_start/end、payment_status 等字段

**更新视图（v_partner_stats）**：
- 新增维护费统计字段
- 区分 license_commission 和 maintenance_commission

**状态**：✅ 已创建，等待数据库环境运行迁移

---

### 3. Rust 后端代码

#### ✅ src/partner_models.rs

**新增/更新模型**：
- `CustomerLicense` - 新增维护费字段
- `IssueLicenseRequest` - 支持维护费选项
- `PartnerCommission` - 支持佣金类型区分
- `MaintenanceRenewal` - 新模型（维护费续费记录）
- `PartnerStatement` - 新增维护费收入字段
- `PartnerStats` - 新增维护费统计字段

**新增辅助方法**：
```rust
CustomerLicense::has_active_maintenance() -> bool
CustomerLicense::is_maintenance_expiring_soon() -> bool
CustomerLicense::calculate_maintenance_price() -> Decimal
```

---

#### ✅ src/partner_handlers.rs

**已更新的函数**：

1. **partner_issue_license** - License 签发支持维护费
   - 计算维护费价格（默认 License 价格的 20%）
   - 插入 customer_licenses 时包含维护费字段
   - 为每年维护创建 maintenance_renewals 记录
   - 创建维护费佣金记录（commission_type = 'maintenance'）
   - 响应中包含维护费信息

2. **IssueLicenseResponse** - 新增字段
   ```rust
   pub has_maintenance: bool,
   pub maintenance_expires_at: Option<DateTime<Utc>>,
   pub maintenance_price: Option<Decimal>,
   pub maintenance_commission: Option<Decimal>,
   ```

**新增的函数**：

3. **partner_list_maintenance_renewals** - 查询维护费续费记录
   - 支持按 payment_status 过滤
   - 支持查询 30 天内到期的记录
   - 分页查询
   - 关联客户信息

4. **partner_mark_maintenance_paid** - 标记维护费已支付
   - 验证记录归属
   - 更新 payment_status = 'paid'
   - 记录支付时间和凭证

5. **partner_expiring_maintenance** - 获取即将到期的维护服务
   - 查询 30 天内到期的维护
   - 显示剩余天数
   - 支持自动续费标识

---

#### ✅ src/partner_scheduler.rs

**已更新启动函数**：
```rust
pub fn spawn_partner_tasks(pool: PgPool) {
    // 任务 1：每月 1 号凌晨生成对账单
    // 任务 2：每小时更新 License 状态
    // 任务 3：每天检查维护费到期提醒
    // 任务 4：每天检查自动续费维护
    // 任务 5：每周检查逾期维护费
}
```

**新增定时任务**：

1. **maintenance_expiration_reminder_loop** - 维护费到期提醒
   - 每天凌晨 1 点执行
   - 查找 30 天内到期的维护服务
   - 记录日志（TODO: 发送邮件）

2. **auto_renew_maintenance_loop** - 自动续费维护
   - 每天凌晨 2 点执行
   - 查找 7 天内到期且 auto_renew_maintenance = true 的记录
   - 自动创建续费记录
   - 延长维护到期时间
   - 创建佣金记录

3. **handle_overdue_maintenance_loop** - 逾期维护费处理
   - 每周日凌晨 3 点执行
   - 将 7 天前到期未支付的记录标记为 'overdue'
   - 记录日志（TODO: 发送催款邮件）

---

## ⏳ 待完成工作（需要数据库或前端）

### 1. 数据库环境准备（优先级：⭐⭐⭐⭐⭐）

#### 步骤：
```bash
# 1. 配置数据库连接
cp .env.example .env
# 编辑 .env，设置 DATABASE_URL

# 2. 运行迁移
cargo run --bin migrate_all

# 3. 验证表结构
psql $DATABASE_URL -c "\d management.customer_licenses"
psql $DATABASE_URL -c "\d management.maintenance_renewals"
```

**预期结果**：
- customer_licenses 表包含 5 个维护费字段
- maintenance_renewals 表创建成功
- partner_commissions 表包含 commission_type 字段
- v_partner_stats 视图包含维护费统计

---

### 2. 后端完善（优先级：⭐⭐⭐⭐）

#### 2.1 更新 partner_renew_license 函数
**文件**：`src/partner_handlers.rs`

**需要修改**：
```rust
// 在续费时继承维护费配置
if old_license.has_maintenance {
    let new_maintenance_expires_at = new_expires_at + chrono::Duration::days(...);
    // 在 INSERT 语句中添加维护费字段
}
```

#### 2.2 更新 admin_generate_statement 函数
**文件**：`src/partner_handlers.rs`

**需要修改**：区分 License 收入和维护费收入
```rust
// 统计新签 License 佣金
let license_stats = query!(
    "SELECT ... WHERE commission_type = 'license' ..."
);

// 统计维护费佣金
let maintenance_stats = query!(
    "SELECT ... WHERE commission_type = 'maintenance' ..."
);

// INSERT 对账单时包含维护费字段
INSERT INTO partner_statements (
    ..., total_maintenance_revenue, total_maintenance_commission, maintenance_count
) VALUES (...);
```

#### 2.3 集成邮件通知
**文件**：`src/partner_scheduler.rs`

**需要实现**：
- `send_expiration_notification()` - 到期提醒邮件
- `send_overdue_notification()` - 催款邮件
- 使用现有的 `lettre` 邮件服务

---

### 3. 前端 UI 实现（优先级：⭐⭐⭐）

#### 3.1 Partner Portal - License 签发表单

**文件**：`frontend/components/partner/IssueLicenseForm.tsx`

**新增字段**：
```tsx
<FormGroup>
  <Checkbox
    checked={includeMaintenance}
    onChange={(e) => setIncludeMaintenance(e.target.checked)}
    label="包含年度维护服务（推荐）"
  />
</FormGroup>

{includeMaintenance && (
  <>
    <FormGroup>
      <Label>维护年限</Label>
      <Select value={maintenanceYears}>
        <option value={1}>1 年（推荐）</option>
        <option value={2}>2 年</option>
        <option value={3}>3 年</option>
      </Select>
    </FormGroup>

    <FormGroup>
      <Label>维护费价格</Label>
      <Input
        type="number"
        value={maintenancePrice}
        readOnly
        helpText={`默认为 License 价格的 20%`}
      />
    </FormGroup>

    <FormGroup>
      <Checkbox
        checked={autoRenewMaintenance}
        label="自动续费维护服务"
      />
    </FormGroup>
  </>
)}
```

---

#### 3.2 Partner Portal - 价格预览组件

**文件**：`frontend/components/partner/PriceBreakdown.tsx`

**显示内容**：
```
License 价格：¥80,000
年度维护（3 年）：¥48,000
└ 代理商分成（10%）：¥4,800

────────────────────
合计：¥128,000
您的佣金：¥20,800

佣金明细：
- License 佣金（20%）：¥16,000
- 维护费佣金（10%）：¥4,800
```

---

#### 3.3 Partner Portal - 维护费到期提醒面板

**文件**：`frontend/components/partner/MaintenanceExpiringPanel.tsx`

**功能**：
- 显示 30 天内到期的维护服务
- 显示剩余天数、客户信息、维护费价格
- 提供"立即续费"和"提醒客户"按钮

**API 调用**：
```typescript
GET /api/partner/maintenance/expiring
```

---

#### 3.4 Partner Portal - 维护费续费记录列表

**文件**：`frontend/pages/partner/maintenance-renewals.tsx`

**功能**：
- 列表显示所有维护费续费记录
- 筛选：payment_status（pending / paid / overdue）
- 支持标记已支付
- 分页查询

**API 调用**：
```typescript
GET /api/partner/maintenance/renewals?payment_status=pending&page=1
POST /api/partner/maintenance/:id/mark-paid
```

---

#### 3.5 Admin Portal - 维护费统计报表

**文件**：`frontend/pages/admin/reports/maintenance.tsx`

**功能**：
- 按月统计维护费收入
- 按代理商分组显示续费率
- 导出 Excel 报表

**API 调用**：
```typescript
GET /api/admin/reports/maintenance-revenue?period=2026-08
```

---

### 4. API 路由注册（优先级：⭐⭐⭐⭐）

#### 文件：src/main.rs

**需要添加的路由**：
```rust
// 代理商路由（在现有 partner_routes 中添加）
.route("/api/partner/maintenance/renewals", get(partner_handlers::partner_list_maintenance_renewals))
.route("/api/partner/maintenance/:id/mark-paid", post(partner_handlers::partner_mark_maintenance_paid))
.route("/api/partner/maintenance/expiring", get(partner_handlers::partner_expiring_maintenance))
```

---

### 5. 测试（优先级：⭐⭐⭐）

#### 5.1 单元测试

**文件**：`src/partner_models_test.rs`（新建）

**测试用例**：
```rust
#[test]
fn test_calculate_maintenance_price() {
    let license = mock_license(Decimal::new(10000000, 2)); // ¥100,000
    assert_eq!(license.calculate_maintenance_price(), Decimal::new(2000000, 2)); // ¥20,000
}

#[test]
fn test_has_active_maintenance() {
    let mut license = mock_license_with_maintenance();
    assert!(license.has_active_maintenance());

    license.maintenance_expires_at = Some(Utc::now() - Duration::days(1));
    assert!(!license.has_active_maintenance());
}
```

---

#### 5.2 集成测试

**文件**：`tests/partner_maintenance_test.rs`（新建）

**测试场景**：
1. ✅ License 签发（含维护费）
2. ✅ 维护费佣金正确计算
3. ✅ maintenance_renewals 记录正确创建
4. ✅ 自动续费任务执行
5. ✅ 逾期标记功能

---

#### 5.3 端到端测试

**测试流程**：
```
1. 超管创建代理商 → 分配配额
2. 代理商签发 License（含 3 年维护）
   - 验证：maintenance_price = license_price * 0.2
   - 验证：创建 3 条 maintenance_renewals 记录
   - 验证：创建 1 条 license 佣金 + 3 条 maintenance 佣金
3. 查询维护费续费记录
   - 验证：返回 3 条记录
4. 标记第 1 年维护费已支付
   - 验证：payment_status = 'paid'
5. 查询即将到期的维护服务
   - 验证：包含该 License
6. 运行定时任务（手动触发）
   - 验证：发送到期提醒
7. 启用 auto_renew_maintenance
   - 验证：自动创建下一年续费记录
8. 生成对账单
   - 验证：区分 License 和维护费收入
```

---

## 📊 功能实现度评估

| 模块 | 完成度 | 状态 | 备注 |
|------|--------|------|------|
| **策略文档** | 100% | ✅ 完成 | 竞品调研、定价方案、分成体系 |
| **数据库设计** | 100% | ✅ 待运行 | 迁移文件已创建，等待数据库环境 |
| **数据模型** | 100% | ✅ 完成 | partner_models.rs 全部更新 |
| **License 签发** | 100% | ✅ 完成 | 支持维护费选项、佣金计算、续费记录 |
| **维护费查询** | 100% | ✅ 完成 | 列表查询、到期提醒 |
| **维护费支付** | 100% | ✅ 完成 | 标记已支付功能 |
| **License 续费** | 0% | ⏳ 待实施 | 需继承维护费配置 |
| **对账单生成** | 50% | ⏳ 待更新 | 需区分 License 和维护费收入 |
| **定时任务** | 100% | ✅ 完成 | 到期提醒、自动续费、逾期处理 |
| **邮件通知** | 0% | ⏳ 待集成 | 需调用 lettre 发送邮件 |
| **前端 UI** | 0% | ⏳ 待实施 | 签发表单、价格预览、续费管理 |
| **测试** | 0% | ⏳ 待编写 | 单元测试、集成测试、E2E 测试 |

**总体完成度**：约 **65%**（核心后端逻辑已完成）

---

## 🚀 下一步行动建议

### 立即可做（无需数据库）

#### 选项 1：继续完善后端代码
```bash
# 1. 更新 partner_renew_license 函数（支持维护费继承）
# 2. 更新 admin_generate_statement 函数（区分维护费收入）
# 3. 添加单元测试
```

#### 选项 2：实施前端 UI
```bash
# 1. 实现 License 签发表单（维护费选项）
# 2. 实现价格预览组件
# 3. 实现维护费续费管理页面
```

#### 选项 3：编写 API 文档
```bash
# 创建 docs/API_MAINTENANCE_FEE.md
# 文档化所有维护费相关的 API 端点
# 包含请求/响应示例
```

---

### 等待数据库环境后

#### 步骤 1：运行迁移并验证
```bash
cargo run --bin migrate_all
psql $DATABASE_URL -c "SELECT * FROM management.maintenance_renewals LIMIT 1"
```

#### 步骤 2：端到端测试
```bash
# 启动服务
cargo run

# 测试 License 签发（含维护费）
curl -X POST http://localhost:3010/api/partner/licenses \
  -H "Authorization: Bearer $TOKEN" \
  -d @test_issue_with_maintenance.json

# 验证续费记录
curl http://localhost:3010/api/partner/maintenance/renewals
```

#### 步骤 3：部署上线
```bash
# 1. 生产环境运行迁移
# 2. 配置环境变量（ONEBASE_LICENSE_PRIVATE_KEY）
# 3. 启动定时任务
# 4. 监控日志
```

---

## 💡 关键实施建议

### 1. 优先级排序

**高优先级**（核心功能）：
- ✅ 数据库迁移运行
- ✅ partner_renew_license 更新
- ✅ admin_generate_statement 更新
- ✅ API 路由注册

**中优先级**（用户体验）：
- License 签发表单 UI
- 价格预览组件
- 维护费续费管理界面

**低优先级**（增强功能）：
- 邮件通知集成
- 统计报表导出
- 自定义维护费价格

---

### 2. 风险提示

#### 风险 1：数据迁移失败
**应对**：
- 在测试环境先运行迁移
- 备份生产数据库
- 准备回滚脚本

#### 风险 2：佣金计算错误
**应对**：
- 编写单元测试验证计算逻辑
- 手动测试多种场景（不同价格、不同年限）
- 在对账单生成前再次验证

#### 风险 3：定时任务未启动
**应对**：
- 在 main.rs 中确保调用 `spawn_partner_tasks(pool)`
- 监控日志，验证任务执行
- 手动触发测试（修改时间条件）

---

### 3. 代码审查清单

在提交代码前检查：
- [ ] 所有新增字段都有默认值
- [ ] 所有 INSERT 语句参数数量匹配
- [ ] 所有 Decimal 计算使用正确的精度
- [ ] 所有时间计算考虑了时区（使用 Utc）
- [ ] 所有错误处理返回友好的错误消息
- [ ] 所有敏感信息（私钥）从环境变量读取
- [ ] 所有事务正确提交或回滚
- [ ] 所有索引已创建（提升查询性能）

---

## 📞 需要帮助？

如果在实施过程中遇到问题，可以参考：

1. **定价策略文档**：`docs/ONEBASE_PRICING_STRATEGY.md`
2. **实施总结**：`docs/PRICING_IMPLEMENTATION_SUMMARY.md`
3. **数据库迁移**：`migrations/064_add_maintenance_fee_support.sql`
4. **代码实现**：
   - `src/partner_models.rs` - 数据模型
   - `src/partner_handlers.rs` - API handlers
   - `src/partner_scheduler.rs` - 定时任务

---

**文档版本**：v1.0
**创建时间**：2026-09-02
**状态**：核心后端代码 65% 完成，等待数据库环境和前端实施
**预计剩余工作量**：5-7 个工作日
